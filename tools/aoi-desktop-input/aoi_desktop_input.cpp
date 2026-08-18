// Aoi desktop-input helper (host-bridge, native input).
//
// Purpose:
//   Aoi can already SEE the desktop (aoi-desktop-capture, screen-vision) but has
//   never been able to touch it. This helper is the acting half: it enumerates
//   windows, snapshots a window's interactable elements via UI Automation, and
//   drives one of them. It is the desktop counterpart of the browser-drive
//   executor and speaks the SAME verdict vocabulary, so both surfaces answer the
//   one question that matters: did the action actually happen.
//
// Why a separate native process (not the daemon, not the browser):
//   - Only a native process in the interactive session can reach UI Automation.
//   - Crash isolation + privilege separation: a COM/UIA fault cannot take the
//     daemon down, and this process holds no secrets at all.
//   - It is a ONE-SHOT command executor, not a daemon: read one JSON command,
//     write one JSON result, exit. There is no resident input capability sitting
//     around waiting to be driven.
//
// Delivery ladder (mirrors the hermes-agent computer-use contract):
//   1. UIA pattern (InvokePattern / ValuePattern / LegacyIAccessible default
//      action). Does NOT move the cursor or steal focus, and the API reports
//      whether it worked -- so this rung can return effect="confirmed".
//   2. SendInput, ONLY with --allow-foreground. This is real mouse/keyboard
//      input: it moves the operator's cursor and requires the window to be
//      foreground. Nothing here can verify the result, so it reports
//      effect="unverifiable" and never claims more.
//   A rung that cannot run says so with a structured code instead of silently
//   falling through to the more invasive one.
//
// Verdict vocabulary (identical to the browser side):
//   effect   = confirmed | unverifiable | suspected_noop
//   verified = true ONLY when a value was read back off the live element
//   path     = which rung actually ran (uia_invoke / uia_value / sendinput)
//
// Safety model (the DAEMON enforces authorization; this adds defense in depth):
//   - No consent/capability check lives here. The daemon decides whether desktop
//     input is allowed at all and only then spawns this. That mirrors the
//     capture helper: running this binary by hand proves nothing about consent.
//   - Focus is never taken unless --allow-foreground is passed explicitly.
//   - Password-like fields are refused outright: an element whose UIA control
//     type is Edit with the password flag, or whose name looks like a
//     credential, is never invoked or written. The daemon blocks these too; a
//     second refusal here means a daemon bug cannot type into a password box.
//   - Refs are valid for ONE snapshot. The snapshot id is a content hash of the
//     window's element identities, so a changed window mints a new id and an
//     older ref is REFUSED rather than re-pointed at whatever now sits at that
//     index.
//
// Usage:
//   aoi_desktop_input.exe --command "<json>"      one-shot, JSON on stdout
//   aoi_desktop_input.exe --stdin                 read the JSON command on stdin
//   aoi_desktop_input.exe --self-test             no COM, prints a sample result
//
// Commands:
//   {"op":"list_windows"}
//   {"op":"snapshot","hwnd":"0x1234"}
//   {"op":"invoke","hwnd":"0x1234","ref":7,"snapshotId":"dis-abc"}
//   {"op":"set_value","hwnd":"0x1234","ref":7,"snapshotId":"dis-abc","value":"hi"}
//
// Build: build.ps1 (auto-locates MSVC). See README.md.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <uiautomation.h>
#include <psapi.h>

#include <string>
#include <vector>
#include <iostream>
#include <sstream>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "psapi.lib")

namespace
{

// Bounded so a pathological window cannot flood the model's context.
const int kMaxElements = 120;
const int kMaxNameChars = 80;

// ---------------------------------------------------------------------------
// Small JSON helpers. Hand-rolled: this binary must stay dependency-free.
// ---------------------------------------------------------------------------

std::string JsonEscape(const std::string& value)
{
    std::string out;
    out.reserve(value.size() + 8);
    for (size_t i = 0; i < value.size(); ++i)
    {
        const unsigned char c = static_cast<unsigned char>(value[i]);
        if (c == '"' || c == '\\')
        {
            out.push_back('\\');
            out.push_back(static_cast<char>(c));
        }
        else if (c == '\n')
        {
            out += "\\n";
        }
        else if (c == '\r')
        {
            out += "\\r";
        }
        else if (c == '\t')
        {
            out += "\\t";
        }
        else if (c < 0x20)
        {
            char buf[8];
            sprintf_s(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
        }
        else
        {
            out.push_back(static_cast<char>(c));
        }
    }
    return out;
}

// Raw text of a TOP-LEVEL key's value.
//
// This replaced a substring search for "\"ref\"", which was shorter and, tested
// head to head, not actually steerable: a JSON string cannot contain a raw
// quote, so an escaped \"ref\" in typed text never matches the needle. What the
// substring search DOES get wrong is structure -- it takes the first match
// anywhere, so a nested object ({"target":{"ref":9},"ref":3}) silently wins over
// the real key, and it reads a value by scanning forward rather than by bounds.
//
// One of these values is text the model chose, and it decides which element gets
// driven. That is not a place to rely on "no one can currently construct the bad
// input"; walking the object and matching only depth-1 keys costs little and
// removes the question.
bool ExtractTopLevelRaw(const std::string& json, const std::string& key, std::string& raw)
{
    size_t i = 0;
    while (i < json.size() && json[i] != '{')
    {
        ++i;
    }
    if (i >= json.size())
    {
        return false;
    }
    ++i;

    while (i < json.size())
    {
        while (i < json.size() &&
               (json[i] == ' ' || json[i] == '\t' || json[i] == '\n' || json[i] == '\r' ||
                json[i] == ','))
        {
            ++i;
        }
        if (i >= json.size() || json[i] == '}')
        {
            break;
        }
        if (json[i] != '"')
        {
            return false;
        }

        std::string name;
        ++i;
        while (i < json.size() && json[i] != '"')
        {
            if (json[i] == '\\' && i + 1 < json.size())
            {
                ++i;
            }
            name.push_back(json[i]);
            ++i;
        }
        if (i >= json.size())
        {
            return false;
        }
        ++i;

        while (i < json.size() && (json[i] == ' ' || json[i] == '\t'))
        {
            ++i;
        }
        if (i >= json.size() || json[i] != ':')
        {
            return false;
        }
        ++i;
        while (i < json.size() && (json[i] == ' ' || json[i] == '\t'))
        {
            ++i;
        }

        const size_t valueStart = i;
        int depth = 0;
        bool inString = false;
        while (i < json.size())
        {
            const char c = json[i];
            if (inString)
            {
                if (c == '\\')
                {
                    i += 2;
                    continue;
                }
                if (c == '"')
                {
                    inString = false;
                }
            }
            else if (c == '"')
            {
                inString = true;
            }
            else if (c == '{' || c == '[')
            {
                ++depth;
            }
            else if (c == '}' || c == ']')
            {
                if (depth == 0)
                {
                    break;
                }
                --depth;
            }
            else if (c == ',' && depth == 0)
            {
                break;
            }
            ++i;
        }

        if (name == key)
        {
            raw = json.substr(valueStart, (i > valueStart ? i - valueStart : 0));
            return true;
        }
    }
    return false;
}

// Minimal scalar readers. Anything missing or malformed yields an empty/fallback
// value, and the operation refuses rather than guessing.
std::string JsonReadString(const std::string& json, const std::string& key)
{
    std::string raw;
    std::string result;
    do
    {
        if (!ExtractTopLevelRaw(json, key, raw))
        {
            break;
        }
        while (!raw.empty() && (raw[raw.size() - 1] == ' ' || raw[raw.size() - 1] == '\t'))
        {
            raw.erase(raw.size() - 1);
        }
        if (raw.size() < 2 || raw[0] != '"' || raw[raw.size() - 1] != '"')
        {
            break;
        }
        for (size_t i = 1; i + 1 < raw.size(); ++i)
        {
            if (raw[i] == '\\' && i + 2 < raw.size())
            {
                ++i;
                const char escaped = raw[i];
                if (escaped == 'n')
                {
                    result.push_back('\n');
                }
                else if (escaped == 't')
                {
                    result.push_back('\t');
                }
                else if (escaped == 'r')
                {
                    result.push_back('\r');
                }
                else
                {
                    result.push_back(escaped);
                }
            }
            else
            {
                result.push_back(raw[i]);
            }
        }
    } while (false);
    return result;
}

long JsonReadNumber(const std::string& json, const std::string& key, long fallback)
{
    std::string raw;
    long result = fallback;
    do
    {
        if (!ExtractTopLevelRaw(json, key, raw))
        {
            break;
        }
        char* end = NULL;
        const long parsed = strtol(raw.c_str(), &end, 10);
        if (end == raw.c_str())
        {
            break;
        }
        result = parsed;
    } while (false);
    return result;
}

std::string Utf8FromWide(const wchar_t* value)
{
    std::string out;
    if (value == NULL || *value == L'\0')
    {
        return out;
    }
    const int needed = WideCharToMultiByte(CP_UTF8, 0, value, -1, NULL, 0, NULL, NULL);
    if (needed <= 1)
    {
        return out;
    }
    out.resize(static_cast<size_t>(needed - 1));
    WideCharToMultiByte(CP_UTF8, 0, value, -1, &out[0], needed, NULL, NULL);
    return out;
}

std::wstring WideFromUtf8(const std::string& value)
{
    std::wstring out;
    if (value.empty())
    {
        return out;
    }
    const int needed = MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, NULL, 0);
    if (needed <= 1)
    {
        return out;
    }
    out.resize(static_cast<size_t>(needed - 1));
    MultiByteToWideChar(CP_UTF8, 0, value.c_str(), -1, &out[0], needed);
    return out;
}

std::string ClampName(const std::string& value)
{
    std::string collapsed;
    bool lastSpace = false;
    for (size_t i = 0; i < value.size(); ++i)
    {
        const char c = value[i];
        const bool isSpace = (c == ' ' || c == '\t' || c == '\n' || c == '\r');
        if (isSpace)
        {
            if (!collapsed.empty() && !lastSpace)
            {
                collapsed.push_back(' ');
            }
            lastSpace = true;
        }
        else
        {
            collapsed.push_back(c);
            lastSpace = false;
        }
    }
    while (!collapsed.empty() && collapsed[collapsed.size() - 1] == ' ')
    {
        collapsed.erase(collapsed.size() - 1);
    }
    if (static_cast<int>(collapsed.size()) > kMaxNameChars)
    {
        collapsed.resize(static_cast<size_t>(kMaxNameChars));
        collapsed += "...";
    }
    return collapsed;
}

// FNV-1a over the element identities. Same contract as the browser snapshot: any
// change to the window's controls mints a new id, so an older ref is refused.
std::string HashSnapshot(const std::string& material)
{
    unsigned int hash = 2166136261u;
    for (size_t i = 0; i < material.size(); ++i)
    {
        hash ^= static_cast<unsigned char>(material[i]);
        hash *= 16777619u;
    }
    char buf[32];
    sprintf_s(buf, sizeof(buf), "dis-%08x", hash);
    return std::string(buf);
}

bool LooksLikeCredential(const std::string& name)
{
    static const char* kNeedles[] = {
        "password", "passwd", "pwd", "credential", "cvc", "cvv",
        "card number", "cardnumber", "otp", "one-time", "passcode", "pin",
    };
    std::string lowered;
    lowered.reserve(name.size());
    for (size_t i = 0; i < name.size(); ++i)
    {
        lowered.push_back(static_cast<char>(tolower(static_cast<unsigned char>(name[i]))));
    }
    for (size_t i = 0; i < sizeof(kNeedles) / sizeof(kNeedles[0]); ++i)
    {
        if (lowered.find(kNeedles[i]) != std::string::npos)
        {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Result emission. Every op answers in the same shape so the daemon can parse
// one contract.
// ---------------------------------------------------------------------------

void EmitFailure(const std::string& code, const std::string& detail)
{
    std::cout << "{\"ok\":false,\"effect\":\"suspected_noop\",\"verified\":false,"
              << "\"code\":\"" << JsonEscape(code) << "\","
              << "\"detail\":\"" << JsonEscape(detail) << "\"}" << std::endl;
}

void EmitVerdict(bool ok,
                 const std::string& effect,
                 bool verified,
                 const std::string& path,
                 const std::string& detail)
{
    std::cout << "{\"ok\":" << (ok ? "true" : "false")
              << ",\"effect\":\"" << JsonEscape(effect) << "\""
              << ",\"verified\":" << (verified ? "true" : "false")
              << ",\"path\":\"" << JsonEscape(path) << "\""
              << ",\"detail\":\"" << JsonEscape(detail) << "\"}" << std::endl;
}

// ---------------------------------------------------------------------------
// Window enumeration
// ---------------------------------------------------------------------------

struct WindowInfo
{
    HWND hwnd;
    std::string title;
    std::string process;
};

std::string ProcessNameOf(HWND hwnd)
{
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    std::string name;
    if (pid == 0)
    {
        return name;
    }
    HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (handle == NULL)
    {
        return name;
    }
    wchar_t path[MAX_PATH];
    DWORD size = MAX_PATH;
    if (QueryFullProcessImageNameW(handle, 0, path, &size) != 0)
    {
        const std::wstring full(path);
        const size_t slash = full.find_last_of(L"\\/");
        // Basename only: the full path is not the daemon's business.
        name = Utf8FromWide(slash == std::wstring::npos ? full.c_str()
                                                        : full.c_str() + slash + 1);
    }
    CloseHandle(handle);
    return name;
}

BOOL CALLBACK CollectWindow(HWND hwnd, LPARAM param)
{
    std::vector<WindowInfo>* out = reinterpret_cast<std::vector<WindowInfo>*>(param);
    if (!IsWindowVisible(hwnd))
    {
        return TRUE;
    }
    const int length = GetWindowTextLengthW(hwnd);
    if (length <= 0)
    {
        return TRUE;
    }
    std::wstring title;
    title.resize(static_cast<size_t>(length) + 1);
    const int copied = GetWindowTextW(hwnd, &title[0], length + 1);
    if (copied <= 0)
    {
        return TRUE;
    }
    title.resize(static_cast<size_t>(copied));
    WindowInfo info;
    info.hwnd = hwnd;
    info.title = ClampName(Utf8FromWide(title.c_str()));
    info.process = ProcessNameOf(hwnd);
    out->push_back(info);
    return TRUE;
}

void RunListWindows()
{
    std::vector<WindowInfo> windows;
    EnumWindows(CollectWindow, reinterpret_cast<LPARAM>(&windows));
    std::ostringstream out;
    out << "{\"ok\":true,\"windows\":[";
    for (size_t i = 0; i < windows.size(); ++i)
    {
        char handle[32];
        sprintf_s(handle, sizeof(handle), "0x%llx",
                  static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(windows[i].hwnd)));
        if (i > 0)
        {
            out << ",";
        }
        out << "{\"hwnd\":\"" << handle << "\",\"title\":\"" << JsonEscape(windows[i].title)
            << "\",\"process\":\"" << JsonEscape(windows[i].process) << "\"}";
    }
    out << "]}";
    std::cout << out.str() << std::endl;
}

// ---------------------------------------------------------------------------
// UIA element snapshot
// ---------------------------------------------------------------------------

struct ElementInfo
{
    int ref;
    std::string role;
    std::string name;
    std::string automationId;
    bool enabled;
    bool sensitive;
    IUIAutomationElement* element;
};

std::string RoleOf(CONTROLTYPEID type)
{
    switch (type)
    {
    case UIA_ButtonControlTypeId:
        return "button";
    case UIA_HyperlinkControlTypeId:
        return "link";
    case UIA_EditControlTypeId:
        return "textbox";
    case UIA_CheckBoxControlTypeId:
        return "checkbox";
    case UIA_RadioButtonControlTypeId:
        return "radio";
    case UIA_ComboBoxControlTypeId:
        return "select";
    case UIA_ListItemControlTypeId:
        return "listitem";
    case UIA_MenuItemControlTypeId:
        return "menuitem";
    case UIA_TabItemControlTypeId:
        return "tab";
    default:
        return "other";
    }
}

bool IsInteractableType(CONTROLTYPEID type)
{
    return type == UIA_ButtonControlTypeId || type == UIA_HyperlinkControlTypeId ||
           type == UIA_EditControlTypeId || type == UIA_CheckBoxControlTypeId ||
           type == UIA_RadioButtonControlTypeId || type == UIA_ComboBoxControlTypeId ||
           type == UIA_ListItemControlTypeId || type == UIA_MenuItemControlTypeId ||
           type == UIA_TabItemControlTypeId;
}

// "Is one of the interactable control types", as a single UIA condition.
//
// This replaced a hand-rolled tree walk, which was wrong in a way only a real
// desktop showed: a depth-capped walk finds nothing at all in a XAML app,
// because those trees nest far past any sane cap (Settings snapshotted as zero
// elements). FindAll has no depth to get wrong, and it crosses the process
// boundary once instead of once per node.
IUIAutomationCondition* BuildInteractableCondition(IUIAutomation* automation)
{
    static const CONTROLTYPEID kTypes[] = {
        UIA_ButtonControlTypeId,      UIA_HyperlinkControlTypeId, UIA_EditControlTypeId,
        UIA_CheckBoxControlTypeId,    UIA_RadioButtonControlTypeId, UIA_ComboBoxControlTypeId,
        UIA_ListItemControlTypeId,    UIA_MenuItemControlTypeId,  UIA_TabItemControlTypeId,
    };

    IUIAutomationCondition* combined = NULL;
    for (size_t i = 0; i < sizeof(kTypes) / sizeof(kTypes[0]); ++i)
    {
        VARIANT value;
        VariantInit(&value);
        value.vt = VT_I4;
        value.lVal = kTypes[i];
        IUIAutomationCondition* one = NULL;
        const HRESULT hr =
            automation->CreatePropertyCondition(UIA_ControlTypePropertyId, value, &one);
        VariantClear(&value);
        if (FAILED(hr) || one == NULL)
        {
            continue;
        }
        if (combined == NULL)
        {
            combined = one;
            continue;
        }
        IUIAutomationCondition* merged = NULL;
        if (SUCCEEDED(automation->CreateOrCondition(combined, one, &merged)) && merged != NULL)
        {
            combined->Release();
            one->Release();
            combined = merged;
        }
        else
        {
            one->Release();
        }
    }
    return combined;
}

void ReadElementInfo(IUIAutomationElement* node, bool cached, ElementInfo& info)
{
    CONTROLTYPEID type = 0;
    BSTR nameRaw = NULL;
    BSTR automationRaw = NULL;
    BOOL enabled = FALSE;
    BOOL isPassword = FALSE;

    if (cached)
    {
        node->get_CachedControlType(&type);
        node->get_CachedName(&nameRaw);
        node->get_CachedAutomationId(&automationRaw);
        node->get_CachedIsEnabled(&enabled);
        node->get_CachedIsPassword(&isPassword);
    }
    else
    {
        node->get_CurrentControlType(&type);
        node->get_CurrentName(&nameRaw);
        node->get_CurrentAutomationId(&automationRaw);
        node->get_CurrentIsEnabled(&enabled);
        node->get_CurrentIsPassword(&isPassword);
    }

    info.role = RoleOf(type);
    info.name = ClampName(Utf8FromWide(nameRaw));
    info.automationId = ClampName(Utf8FromWide(automationRaw));
    info.enabled = (enabled != FALSE);
    // Two independent reasons to refuse: the control declares itself a password
    // box, or its label reads like a credential.
    info.sensitive = (isPassword != FALSE) || LooksLikeCredential(info.name) ||
                     LooksLikeCredential(info.automationId);

    if (nameRaw != NULL)
    {
        SysFreeString(nameRaw);
    }
    if (automationRaw != NULL)
    {
        SysFreeString(automationRaw);
    }
}

void ReleaseElements(std::vector<ElementInfo>& elements)
{
    for (size_t i = 0; i < elements.size(); ++i)
    {
        if (elements[i].element != NULL)
        {
            elements[i].element->Release();
            elements[i].element = NULL;
        }
    }
}

std::string SnapshotIdFor(HWND hwnd, const std::vector<ElementInfo>& elements)
{
    std::ostringstream material;
    material << reinterpret_cast<uintptr_t>(hwnd);
    for (size_t i = 0; i < elements.size(); ++i)
    {
        material << "|" << elements[i].role << ":" << elements[i].automationId << ":"
                 << elements[i].name;
    }
    return HashSnapshot(material.str());
}

// Collect the window's interactable elements, in tree order. Returns false when
// the window or the automation tree cannot be reached at all.
//
// Tree order is what makes a ref meaningful: the same window in the same state
// always numbers its elements the same way, and any change to that ordering
// changes the snapshot id and so retires every outstanding ref.
bool CollectElements(IUIAutomation* automation,
                     HWND hwnd,
                     std::vector<ElementInfo>& out,
                     std::string& error)
{
    IUIAutomationElement* root = NULL;
    IUIAutomationCondition* condition = NULL;
    IUIAutomationCacheRequest* cache = NULL;
    IUIAutomationElementArray* found = NULL;
    bool ok = false;

    do
    {
        if (FAILED(automation->ElementFromHandle(hwnd, &root)) || root == NULL)
        {
            error = "window has no automation element";
            break;
        }
        condition = BuildInteractableCondition(automation);
        if (condition == NULL)
        {
            error = "could not build the element condition";
            break;
        }

        // Fetch every property the snapshot prints in one cross-process trip.
        // AutomationElementMode_Full keeps the live reference, so the returned
        // elements can still be invoked afterwards.
        if (SUCCEEDED(automation->CreateCacheRequest(&cache)) && cache != NULL)
        {
            cache->AddProperty(UIA_NamePropertyId);
            cache->AddProperty(UIA_AutomationIdPropertyId);
            cache->AddProperty(UIA_ControlTypePropertyId);
            cache->AddProperty(UIA_IsEnabledPropertyId);
            cache->AddProperty(UIA_IsPasswordPropertyId);
            cache->put_AutomationElementMode(AutomationElementMode_Full);
        }

        HRESULT hr;
        if (cache != NULL)
        {
            hr = root->FindAllBuildCache(TreeScope_Subtree, condition, cache, &found);
        }
        else
        {
            hr = root->FindAll(TreeScope_Subtree, condition, &found);
        }
        if (FAILED(hr) || found == NULL)
        {
            error = "the window did not answer an element query";
            break;
        }

        int count = 0;
        found->get_Length(&count);
        for (int i = 0; i < count && static_cast<int>(out.size()) < kMaxElements; ++i)
        {
            IUIAutomationElement* node = NULL;
            if (FAILED(found->GetElement(i, &node)) || node == NULL)
            {
                continue;
            }
            ElementInfo info;
            info.ref = static_cast<int>(out.size()) + 1;
            info.element = node; // ownership moves into out; ReleaseElements frees it
            ReadElementInfo(node, cache != NULL, info);
            out.push_back(info);
        }
        ok = true;
    } while (false);

    if (found != NULL)
    {
        found->Release();
    }
    if (cache != NULL)
    {
        cache->Release();
    }
    if (condition != NULL)
    {
        condition->Release();
    }
    if (root != NULL)
    {
        root->Release();
    }
    return ok;
}

// Does this window expose ANY automation children at all?
//
// Only asked when the interactable list came back empty, to separate two very
// different facts that otherwise print identically. Some windows (XAML/UWP under
// ApplicationFrameHost is the common one) hand UI Automation nothing at all --
// observed on a live, non-minimized Settings window. "Zero buttons here" invites
// the model to conclude the window is empty; "this window will not describe
// itself" tells it to go look with vision instead.
bool WindowExposesAnyElements(IUIAutomation* automation, HWND hwnd)
{
    IUIAutomationElement* root = NULL;
    IUIAutomationCondition* anything = NULL;
    IUIAutomationElementArray* found = NULL;
    bool exposes = false;

    do
    {
        if (FAILED(automation->ElementFromHandle(hwnd, &root)) || root == NULL)
        {
            break;
        }
        if (FAILED(automation->CreateTrueCondition(&anything)) || anything == NULL)
        {
            break;
        }
        if (FAILED(root->FindAll(TreeScope_Children, anything, &found)) || found == NULL)
        {
            break;
        }
        int count = 0;
        found->get_Length(&count);
        exposes = (count > 0);
    } while (false);

    if (found != NULL)
    {
        found->Release();
    }
    if (anything != NULL)
    {
        anything->Release();
    }
    if (root != NULL)
    {
        root->Release();
    }
    return exposes;
}

void RunSnapshot(IUIAutomation* automation, HWND hwnd)
{
    std::vector<ElementInfo> elements;
    std::string error;
    if (!CollectElements(automation, hwnd, elements, error))
    {
        EmitFailure("snapshot_unavailable", error);
        return;
    }

    // An empty list is ambiguous, so say which kind of empty it is.
    std::string note = "ok";
    if (elements.empty())
    {
        note = WindowExposesAnyElements(automation, hwnd) ? "no_interactable_elements"
                                                          : "no_automation_tree";
    }

    const std::string id = SnapshotIdFor(hwnd, elements);
    std::ostringstream out;
    out << "{\"ok\":true,\"snapshotId\":\"" << id << "\",\"note\":\"" << note
        << "\",\"elements\":[";
    for (size_t i = 0; i < elements.size(); ++i)
    {
        if (i > 0)
        {
            out << ",";
        }
        out << "{\"ref\":" << elements[i].ref << ",\"role\":\"" << JsonEscape(elements[i].role)
            << "\",\"name\":\"" << JsonEscape(elements[i].name) << "\",\"automationId\":\""
            << JsonEscape(elements[i].automationId) << "\""
            << ",\"enabled\":" << (elements[i].enabled ? "true" : "false")
            << ",\"sensitive\":" << (elements[i].sensitive ? "true" : "false") << "}";
    }
    out << "]}";
    std::cout << out.str() << std::endl;
    ReleaseElements(elements);
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

// Resolve a ref against a FRESH snapshot of the window and check the id. The id
// is a content hash, so a mismatch means the window changed since the caller
// looked and the ref is refused rather than re-pointed.
bool ResolveRef(IUIAutomation* automation,
                HWND hwnd,
                int ref,
                const std::string& expectedSnapshotId,
                std::vector<ElementInfo>& elements,
                size_t& index,
                std::string& failureCode,
                std::string& failureDetail)
{
    std::string error;
    if (!CollectElements(automation, hwnd, elements, error))
    {
        failureCode = "snapshot_unavailable";
        failureDetail = error;
        return false;
    }
    const std::string actual = SnapshotIdFor(hwnd, elements);
    if (expectedSnapshotId.empty() || actual != expectedSnapshotId)
    {
        failureCode = "element_ref_stale";
        failureDetail = "the window changed since the snapshot; take a fresh one (now " + actual + ")";
        return false;
    }
    if (ref < 1 || ref > static_cast<int>(elements.size()))
    {
        failureCode = "element_ref_unknown";
        failureDetail = "ref out of range for this snapshot";
        return false;
    }
    index = static_cast<size_t>(ref - 1);
    if (elements[index].sensitive)
    {
        failureCode = "element_forbidden";
        failureDetail = "credential fields are never driven by Aoi";
        return false;
    }
    if (!elements[index].enabled)
    {
        failureCode = "element_disabled";
        failureDetail = "the element is disabled; acting on it would do nothing";
        return false;
    }
    return true;
}

// Ask for the foreground and CONFIRM we got it.
//
// Windows routinely refuses a foreground change requested by a background
// process -- it flashes the taskbar instead and SetForegroundWindow reports
// nothing useful. The daemon spawns this helper from the background, which is
// exactly the case where the refusal happens. Clicking anyway would send a real
// mouse click at screen coordinates now owned by whatever window IS in front:
// Aoi would click something on the operator's desktop that nobody asked about.
bool BringToForeground(HWND hwnd)
{
    const HWND wanted = GetAncestor(hwnd, GA_ROOT);
    SetForegroundWindow(hwnd);
    for (int attempt = 0; attempt < 20; ++attempt)
    {
        const HWND current = GetForegroundWindow();
        if (current != NULL && GetAncestor(current, GA_ROOT) == wanted)
        {
            return true;
        }
        Sleep(50);
    }
    return false;
}

// Rung 2. Real mouse input: moves the operator's cursor and needs the window in
// front, so it only runs with --allow-foreground and never claims verification.
bool SendInputClick(HWND hwnd, IUIAutomationElement* element, std::string& code,
                    std::string& detail)
{
    RECT rect;
    if (FAILED(element->get_CurrentBoundingRectangle(&rect)))
    {
        code = "element_not_on_screen";
        detail = "element has no on-screen rectangle";
        return false;
    }
    if (rect.right <= rect.left || rect.bottom <= rect.top)
    {
        code = "element_not_on_screen";
        detail = "element is not on screen";
        return false;
    }
    const int x = rect.left + (rect.right - rect.left) / 2;
    const int y = rect.top + (rect.bottom - rect.top) / 2;

    if (!BringToForeground(hwnd))
    {
        code = "foreground_denied";
        detail = "Windows refused to bring the window forward; clicking now would hit whatever "
                 "is actually in front";
        return false;
    }

    // Even in front, the point can be covered (a dialog, an always-on-top
    // window, another app's overlay). Aim only where the target really is.
    POINT point;
    point.x = x;
    point.y = y;
    const HWND atPoint = WindowFromPoint(point);
    if (atPoint == NULL || GetAncestor(atPoint, GA_ROOT) != GetAncestor(hwnd, GA_ROOT))
    {
        code = "element_obscured";
        detail = "another window covers the click point";
        return false;
    }

    // Absolute coordinates are normalized across the VIRTUAL screen, whose
    // origin is negative when a monitor sits left of or above the primary one.
    // Dropping that origin puts the click on the wrong monitor entirely.
    const int originX = GetSystemMetrics(SM_XVIRTUALSCREEN);
    const int originY = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const int screenWidth = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    const int screenHeight = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (screenWidth <= 1 || screenHeight <= 1)
    {
        code = "no_screen_metrics";
        detail = "no virtual screen metrics";
        return false;
    }

    INPUT inputs[3];
    ZeroMemory(inputs, sizeof(inputs));
    inputs[0].type = INPUT_MOUSE;
    inputs[0].mi.dx =
        static_cast<LONG>((static_cast<double>(x - originX) * 65535.0) / (screenWidth - 1));
    inputs[0].mi.dy =
        static_cast<LONG>((static_cast<double>(y - originY) * 65535.0) / (screenHeight - 1));
    inputs[0].mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    inputs[1].type = INPUT_MOUSE;
    inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    inputs[2].type = INPUT_MOUSE;
    inputs[2].mi.dwFlags = MOUSEEVENTF_LEFTUP;

    const UINT sent = SendInput(3, inputs, sizeof(INPUT));
    if (sent != 3)
    {
        code = "input_blocked";
        detail = "SendInput was blocked (UIPI or a higher-privilege window)";
        return false;
    }
    detail = "clicked by synthetic mouse input at the element center";
    return true;
}

void RunInvoke(IUIAutomation* automation, HWND hwnd, int ref,
               const std::string& snapshotId, bool allowForeground)
{
    std::vector<ElementInfo> elements;
    size_t index = 0;
    std::string code;
    std::string detail;
    if (!ResolveRef(automation, hwnd, ref, snapshotId, elements, index, code, detail))
    {
        EmitFailure(code, detail);
        ReleaseElements(elements);
        return;
    }

    IUIAutomationElement* element = elements[index].element;

    // Rung 1: UIA InvokePattern. No focus steal, and the call reports success.
    IUIAutomationInvokePattern* invoke = NULL;
    if (SUCCEEDED(element->GetCurrentPatternAs(UIA_InvokePatternId, __uuidof(IUIAutomationInvokePattern),
                                               reinterpret_cast<void**>(&invoke))) &&
        invoke != NULL)
    {
        const HRESULT hr = invoke->Invoke();
        invoke->Release();
        if (SUCCEEDED(hr))
        {
            EmitVerdict(true, "confirmed", false, "uia_invoke", "InvokePattern reported success");
            ReleaseElements(elements);
            return;
        }
        EmitVerdict(false, "suspected_noop", false, "uia_invoke", "InvokePattern failed");
        ReleaseElements(elements);
        return;
    }

    // Rung 2: only on explicit request. Refusing loudly beats silently escalating
    // to real input the operator did not ask for.
    if (!allowForeground)
    {
        EmitFailure("uia_unsupported",
                    "the element exposes no InvokePattern; re-run with --allow-foreground to "
                    "use synthetic input");
        ReleaseElements(elements);
        return;
    }

    std::string clickCode;
    std::string clickDetail;
    if (SendInputClick(hwnd, element, clickCode, clickDetail))
    {
        // The click was aimed at the target and delivered, but nothing here can
        // prove the app did anything with it.
        EmitVerdict(true, "unverifiable", false, "sendinput", clickDetail);
    }
    else
    {
        // Refused BEFORE any input was synthesized: no click happened at all.
        EmitFailure(clickCode, clickDetail);
    }
    ReleaseElements(elements);
}

void RunSetValue(IUIAutomation* automation, HWND hwnd, int ref,
                 const std::string& snapshotId, const std::string& value)
{
    std::vector<ElementInfo> elements;
    size_t index = 0;
    std::string code;
    std::string detail;
    if (!ResolveRef(automation, hwnd, ref, snapshotId, elements, index, code, detail))
    {
        EmitFailure(code, detail);
        ReleaseElements(elements);
        return;
    }

    IUIAutomationElement* element = elements[index].element;
    IUIAutomationValuePattern* pattern = NULL;
    if (FAILED(element->GetCurrentPatternAs(UIA_ValuePatternId, __uuidof(IUIAutomationValuePattern),
                                            reinterpret_cast<void**>(&pattern))) ||
        pattern == NULL)
    {
        EmitFailure("uia_unsupported", "the element exposes no ValuePattern");
        ReleaseElements(elements);
        return;
    }

    const std::wstring wide = WideFromUtf8(value);
    BSTR toWrite = SysAllocString(wide.c_str());
    const HRESULT hr = pattern->SetValue(toWrite);
    if (toWrite != NULL)
    {
        SysFreeString(toWrite);
    }
    if (FAILED(hr))
    {
        pattern->Release();
        EmitVerdict(false, "suspected_noop", false, "uia_value", "SetValue failed");
        ReleaseElements(elements);
        return;
    }

    // Read the value back off the live element. This is the only thing in the
    // whole ladder that earns verified=true -- the browser side learned the hard
    // way that reading the wrong property turns a correct write into a reported
    // no-op, so this reads what SetValue actually wrote.
    BSTR readBack = NULL;
    const bool readOk = SUCCEEDED(pattern->get_CurrentValue(&readBack)) && readBack != NULL;
    const std::string actual = readOk ? Utf8FromWide(readBack) : std::string();
    if (readBack != NULL)
    {
        SysFreeString(readBack);
    }
    pattern->Release();

    if (!readOk)
    {
        EmitVerdict(true, "unverifiable", false, "uia_value",
                    "SetValue returned success but the value could not be read back");
    }
    else if (actual == value)
    {
        EmitVerdict(true, "confirmed", true, "uia_value", "value read back and matches");
    }
    else if (actual.empty() && !value.empty())
    {
        // Two different things look identical from here: the write bounced, or
        // the control masks its content (UIA reports an empty value for masked
        // fields no matter what they hold). Both stay suspected_noop -- never
        // claim an unproven write -- but the operator gets told which is which.
        EmitVerdict(false, "suspected_noop", false, "uia_value",
                    "the element reads back empty; either the write was rejected or the "
                    "control does not reveal its value");
    }
    else
    {
        EmitVerdict(false, "suspected_noop", false, "uia_value",
                    "the element holds a different value after the write");
    }
    ReleaseElements(elements);
}

HWND ParseHwnd(const std::string& text)
{
    if (text.empty())
    {
        return NULL;
    }
    const int base = (text.size() > 2 && text[0] == '0' && (text[1] == 'x' || text[1] == 'X')) ? 16 : 10;
    char* end = NULL;
    const unsigned long long parsed = _strtoui64(text.c_str(), &end, base);
    if (end == text.c_str() || parsed == 0)
    {
        return NULL;
    }
    return reinterpret_cast<HWND>(static_cast<uintptr_t>(parsed));
}

} // namespace

int main(int argc, char** argv)
{
    std::string command;
    bool allowForeground = false;
    bool readStdin = false;
    bool selfTest = false;

    for (int i = 1; i < argc; ++i)
    {
        const std::string arg = argv[i];
        if (arg == "--command" && i + 1 < argc)
        {
            command = argv[++i];
        }
        else if (arg == "--allow-foreground")
        {
            allowForeground = true;
        }
        else if (arg == "--stdin")
        {
            readStdin = true;
        }
        else if (arg == "--self-test")
        {
            selfTest = true;
        }
    }

    if (selfTest)
    {
        // No COM, no desktop: proves the binary runs and emits the contract.
        EmitVerdict(true, "confirmed", true, "self_test", "helper is runnable");
        return 0;
    }

    if (readStdin)
    {
        std::ostringstream buffer;
        buffer << std::cin.rdbuf();
        command = buffer.str();
    }

    if (command.empty())
    {
        EmitFailure("bad_request", "no command; pass --command <json> or --stdin");
        return 2;
    }

    const std::string op = JsonReadString(command, "op");
    if (op.empty())
    {
        EmitFailure("bad_request", "command has no op");
        return 2;
    }

    if (op == "list_windows")
    {
        RunListWindows();
        return 0;
    }

    const HWND hwnd = ParseHwnd(JsonReadString(command, "hwnd"));
    if (hwnd == NULL || IsWindow(hwnd) == FALSE)
    {
        EmitFailure("window_not_found", "hwnd is missing or no longer a window");
        return 2;
    }

    int exitCode = 0;
    const HRESULT comInit = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(comInit))
    {
        EmitFailure("com_init_failed", "CoInitializeEx failed");
        return 2;
    }

    IUIAutomation* automation = NULL;
    const HRESULT created = CoCreateInstance(__uuidof(CUIAutomation), NULL, CLSCTX_INPROC_SERVER,
                                             __uuidof(IUIAutomation),
                                             reinterpret_cast<void**>(&automation));
    if (FAILED(created) || automation == NULL)
    {
        EmitFailure("uia_unavailable", "UI Automation could not be created");
        CoUninitialize();
        return 2;
    }

    const int ref = static_cast<int>(JsonReadNumber(command, "ref", 0));
    const std::string snapshotId = JsonReadString(command, "snapshotId");

    if (op == "snapshot")
    {
        RunSnapshot(automation, hwnd);
    }
    else if (op == "invoke")
    {
        RunInvoke(automation, hwnd, ref, snapshotId, allowForeground);
    }
    else if (op == "set_value")
    {
        RunSetValue(automation, hwnd, ref, snapshotId, JsonReadString(command, "value"));
    }
    else
    {
        EmitFailure("bad_request", "unknown op");
        exitCode = 2;
    }

    automation->Release();
    CoUninitialize();
    return exitCode;
}

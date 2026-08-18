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
        else if (c < 0x80)
        {
            out.push_back(static_cast<char>(c));
        }
        else
        {
            // Escape every non-ASCII character instead of passing UTF-8 through.
            //
            // This output crosses a process boundary to a reader whose decoding
            // is not ours to choose. A shell on a non-UTF-8 codepage -- the
            // default on this machine -- transcodes the bytes before any parser
            // sees them, and window titles and control names on a Korean or
            // Japanese desktop are routinely non-ASCII, so that corrupts real
            // results rather than exotic ones. Pure ASCII cannot be mangled.
            const size_t remaining = value.size() - i;
            unsigned int codepoint = 0;
            size_t length = 0;
            if ((c & 0xE0) == 0xC0 && remaining >= 2)
            {
                codepoint = c & 0x1Fu;
                length = 2;
            }
            else if ((c & 0xF0) == 0xE0 && remaining >= 3)
            {
                codepoint = c & 0x0Fu;
                length = 3;
            }
            else if ((c & 0xF8) == 0xF0 && remaining >= 4)
            {
                codepoint = c & 0x07u;
                length = 4;
            }

            bool valid = (length != 0);
            for (size_t k = 1; k < length && valid; ++k)
            {
                const unsigned char follow = static_cast<unsigned char>(value[i + k]);
                if ((follow & 0xC0) != 0x80)
                {
                    valid = false;
                    break;
                }
                codepoint = (codepoint << 6) | (follow & 0x3Fu);
            }

            char buf[16];
            if (!valid)
            {
                // A truncated or malformed sequence becomes the replacement
                // character rather than broken JSON.
                out += "\\ufffd";
                continue;
            }
            i += length - 1;
            if (codepoint >= 0x10000)
            {
                const unsigned int adjusted = codepoint - 0x10000;
                sprintf_s(buf, sizeof(buf), "\\u%04x\\u%04x", 0xD800 + (adjusted >> 10),
                          0xDC00 + (adjusted & 0x3FF));
            }
            else
            {
                sprintf_s(buf, sizeof(buf), "\\u%04x", codepoint);
            }
            out += buf;
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
        // Back off to a UTF-8 character boundary. Cutting at a fixed byte count
        // splits a multi-byte character, and these names are Korean on this
        // machine -- so the naive version mangles the common case, not an
        // exotic one.
        size_t cut = static_cast<size_t>(kMaxNameChars);
        while (cut > 0 && (static_cast<unsigned char>(collapsed[cut]) & 0xC0) == 0x80)
        {
            --cut;
        }
        collapsed.resize(cut);
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

// Scrollbar parts are not things to click -- there is a `scroll` op for that,
// and it can prove it worked, which clicking an arrow cannot.
//
// They also had to go for a sharper reason: these buttons APPEAR AND DISAPPEAR
// with scroll position (the page-up button does not exist while a view is at the
// top). Since the snapshot id hashes the element identities, scrolling anything
// silently retired every ref in the window and turned "scroll, then click" into
// a guaranteed stale-ref refusal. Excluding them removes the volatility without
// loosening the guard: a real change to the controls still retires the snapshot.
bool IsScrollBarPart(const std::string& automationId)
{
    static const char* kParts[] = {
        "UpButton",     "DownButton",     "LeftButton",     "RightButton",
        "UpPageButton", "DownPageButton", "LeftPageButton", "RightPageButton",
    };
    for (size_t i = 0; i < sizeof(kParts) / sizeof(kParts[0]); ++i)
    {
        if (automationId == kParts[i])
        {
            return true;
        }
    }
    return false;
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

    // Two independent reasons to refuse. The control declaring itself a password
    // box is decisive on its own, for any control type.
    //
    // The name heuristic is deliberately narrower: it applies only to controls
    // that ACCEPT TEXT. Windows associates a label with a control by z-order, so
    // an unrelated dropdown sitting under a "Password:" static inherits that as
    // its accessible name -- observed in the test fixture, where it refused a
    // combo box. A credential cannot be typed into a dropdown or a button, so
    // matching on their labels only costs availability without buying safety.
    const bool acceptsText = (type == UIA_EditControlTypeId || type == UIA_DocumentControlTypeId);
    info.sensitive = (isPassword != FALSE) ||
                     (acceptsText &&
                      (LooksLikeCredential(info.name) || LooksLikeCredential(info.automationId)));

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
                     std::string& error,
                     int* totalFound = NULL)
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

        // The whole array is walked even after the cap is reached, so the count
        // reported back is the number of elements that WOULD be addressable.
        // A cap that reports nothing turns "here are 120 of 400 controls" into
        // "here are the controls", and the caller stops looking for the other
        // 280. Properties are already cached, so the extra passes are cheap.
        int eligible = 0;
        for (int i = 0; i < count; ++i)
        {
            IUIAutomationElement* node = NULL;
            if (FAILED(found->GetElement(i, &node)) || node == NULL)
            {
                continue;
            }
            ElementInfo info;
            ReadElementInfo(node, cache != NULL, info);
            if (IsScrollBarPart(info.automationId))
            {
                node->Release();
                continue;
            }
            eligible += 1;
            if (static_cast<int>(out.size()) >= kMaxElements)
            {
                node->Release();
                continue;
            }
            info.ref = static_cast<int>(out.size()) + 1;
            info.element = node; // ownership moves into out; ReleaseElements frees it
            out.push_back(info);
        }
        if (totalFound != NULL)
        {
            *totalFound = eligible;
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
    int totalFound = 0;
    if (!CollectElements(automation, hwnd, elements, error, &totalFound))
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

    const int shown = static_cast<int>(elements.size());
    const std::string id = SnapshotIdFor(hwnd, elements);
    std::ostringstream out;
    out << "{\"ok\":true,\"snapshotId\":\"" << id << "\",\"note\":\"" << note
        << "\",\"totalElements\":" << totalFound
        << ",\"truncated\":" << ((totalFound > shown) ? "true" : "false") << ",\"elements\":[";
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

// ---------------------------------------------------------------------------
// Input vocabulary: keys, text, clicks, scroll, drag.
//
// Three delivery rungs, weakest side effect first:
//
//   1. uia_*        a UI Automation pattern. No focus steal, no cursor move,
//                   and the API reports success -- the only rung that can be
//                   confirmed.
//   2. background   messages posted straight to the target window. No focus
//                   steal and no cursor move, but nothing reports whether the
//                   app acted on them, so it is unverifiable. Many Win32 apps
//                   accept these; Chromium/Electron and DirectInput games
//                   often ignore them. That is NOT predictable from the app --
//                   it has to be attempted and then checked.
//   3. foreground   real SendInput. Takes focus, moves the cursor, and is
//                   equally unverifiable. Restores the previously focused
//                   window afterwards, because leaving the operator's focus
//                   somewhere they did not put it is itself a side effect.
//
// A caller may pin a rung; "auto" walks them in order. Rung 3 always needs
// --allow-foreground on top of whatever was asked for.
// ---------------------------------------------------------------------------

enum DeliveryMode
{
    kDeliveryAuto = 0,
    kDeliveryBackground,
    kDeliveryForeground,
};

DeliveryMode ParseDelivery(const std::string& value)
{
    if (value == "background")
    {
        return kDeliveryBackground;
    }
    if (value == "foreground")
    {
        return kDeliveryForeground;
    }
    return kDeliveryAuto;
}

struct KeyName
{
    const char* name;
    WORD vk;
};

// Named keys a model actually reaches for. Single printable characters are
// handled separately by layout-aware translation.
const KeyName kKeyNames[] = {
    {"enter", VK_RETURN},    {"return", VK_RETURN},   {"tab", VK_TAB},
    {"escape", VK_ESCAPE},   {"esc", VK_ESCAPE},      {"space", VK_SPACE},
    {"backspace", VK_BACK},  {"delete", VK_DELETE},   {"del", VK_DELETE},
    {"insert", VK_INSERT},   {"home", VK_HOME},       {"end", VK_END},
    {"pageup", VK_PRIOR},    {"pagedown", VK_NEXT},   {"up", VK_UP},
    {"down", VK_DOWN},       {"left", VK_LEFT},       {"right", VK_RIGHT},
    {"f1", VK_F1},           {"f2", VK_F2},           {"f3", VK_F3},
    {"f4", VK_F4},           {"f5", VK_F5},           {"f6", VK_F6},
    {"f7", VK_F7},           {"f8", VK_F8},           {"f9", VK_F9},
    {"f10", VK_F10},         {"f11", VK_F11},         {"f12", VK_F12},
};

bool IsModifierName(const std::string& token, WORD& vk)
{
    if (token == "ctrl" || token == "control")
    {
        vk = VK_CONTROL;
        return true;
    }
    if (token == "shift")
    {
        vk = VK_SHIFT;
        return true;
    }
    if (token == "alt" || token == "option")
    {
        vk = VK_MENU;
        return true;
    }
    if (token == "win" || token == "windows" || token == "super" || token == "meta" ||
        token == "cmd")
    {
        vk = VK_LWIN;
        return true;
    }
    return false;
}

// Split "ctrl+shift+s" into held modifiers plus one main key. Returns false when
// the combo names no usable main key -- refusing beats pressing something else.
bool ParseKeyCombo(const std::string& combo, std::vector<WORD>& modifiers, WORD& mainKey)
{
    modifiers.clear();
    mainKey = 0;

    std::vector<std::string> tokens;
    std::string current;
    for (size_t i = 0; i <= combo.size(); ++i)
    {
        const char c = (i < combo.size()) ? combo[i] : '+';
        if (c == '+')
        {
            if (!current.empty())
            {
                tokens.push_back(current);
                current.clear();
            }
        }
        else
        {
            current.push_back(static_cast<char>(tolower(static_cast<unsigned char>(c))));
        }
    }

    for (size_t i = 0; i < tokens.size(); ++i)
    {
        WORD modifier = 0;
        if (IsModifierName(tokens[i], modifier))
        {
            modifiers.push_back(modifier);
            continue;
        }
        if (mainKey != 0)
        {
            // Two main keys is not a combo this can deliver honestly.
            return false;
        }
        bool matched = false;
        for (size_t k = 0; k < sizeof(kKeyNames) / sizeof(kKeyNames[0]); ++k)
        {
            if (tokens[i] == kKeyNames[k].name)
            {
                mainKey = kKeyNames[k].vk;
                matched = true;
                break;
            }
        }
        if (matched)
        {
            continue;
        }
        if (tokens[i].size() == 1)
        {
            // Layout-aware: 's' must be whatever key produces 's' here.
            const SHORT scan = VkKeyScanA(tokens[i][0]);
            if (scan == -1)
            {
                return false;
            }
            mainKey = static_cast<WORD>(scan & 0xFF);
            const int scanModifiers = (scan >> 8) & 0xFF;
            if (scanModifiers & 1)
            {
                modifiers.push_back(VK_SHIFT);
            }
            if (scanModifiers & 2)
            {
                modifiers.push_back(VK_CONTROL);
            }
            if (scanModifiers & 4)
            {
                modifiers.push_back(VK_MENU);
            }
            continue;
        }
        return false;
    }
    return mainKey != 0;
}

// Modifiers may arrive as "ctrl+shift", "ctrl,shift", or ["ctrl","shift"].
// Rather than pick one and reject the rest on a technicality, this scans the raw
// value for known modifier names -- there is nothing else in that field for a
// name to be confused with, and a caller whose modifier was silently dropped
// would get a plain click reported as the modified one they asked for.
void ParseModifierList(const std::string& raw, std::vector<WORD>& modifiers)
{
    modifiers.clear();
    std::string token;
    for (size_t i = 0; i <= raw.size(); ++i)
    {
        const char c = (i < raw.size()) ? raw[i] : ',';
        const bool isWord = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
        if (isWord)
        {
            token.push_back(static_cast<char>(tolower(static_cast<unsigned char>(c))));
            continue;
        }
        if (!token.empty())
        {
            WORD vk = 0;
            if (IsModifierName(token, vk))
            {
                bool already = false;
                for (size_t k = 0; k < modifiers.size(); ++k)
                {
                    if (modifiers[k] == vk)
                    {
                        already = true;
                        break;
                    }
                }
                if (!already)
                {
                    modifiers.push_back(vk);
                }
            }
            token.clear();
        }
    }
}

// The window inside the target that currently has keyboard focus. Background
// key/text messages have to go THERE, not to the top-level frame, or they land
// nowhere.
HWND FocusedChildOf(HWND hwnd)
{
    const DWORD threadId = GetWindowThreadProcessId(hwnd, NULL);
    if (threadId == 0)
    {
        return NULL;
    }
    GUITHREADINFO info;
    ZeroMemory(&info, sizeof(info));
    info.cbSize = sizeof(info);
    if (GetGUIThreadInfo(threadId, &info) == FALSE)
    {
        return NULL;
    }
    if (info.hwndFocus != NULL)
    {
        return info.hwndFocus;
    }
    // No focused control in that thread: the frame itself is the best target.
    return hwnd;
}

// Deepest child window at a screen point, without WindowFromPoint -- which only
// answers for whatever is visibly on top and so cannot address a background or
// partly covered window at all.
HWND ChildAtScreenPoint(HWND top, POINT screenPoint, POINT& clientPoint)
{
    HWND current = top;
    POINT point = screenPoint;
    ScreenToClient(current, &point);
    for (int depth = 0; depth < 16; ++depth)
    {
        const HWND child = RealChildWindowFromPoint(current, point);
        if (child == NULL || child == current)
        {
            break;
        }
        MapWindowPoints(current, child, &point, 1);
        current = child;
    }
    clientPoint = point;
    return current;
}

void PressForegroundKeys(const std::vector<WORD>& modifiers, WORD mainKey)
{
    std::vector<INPUT> inputs;
    for (size_t i = 0; i < modifiers.size(); ++i)
    {
        INPUT down;
        ZeroMemory(&down, sizeof(down));
        down.type = INPUT_KEYBOARD;
        down.ki.wVk = modifiers[i];
        inputs.push_back(down);
    }
    INPUT keyDown;
    ZeroMemory(&keyDown, sizeof(keyDown));
    keyDown.type = INPUT_KEYBOARD;
    keyDown.ki.wVk = mainKey;
    inputs.push_back(keyDown);

    INPUT keyUp = keyDown;
    keyUp.ki.dwFlags = KEYEVENTF_KEYUP;
    inputs.push_back(keyUp);
    for (size_t i = modifiers.size(); i > 0; --i)
    {
        INPUT up;
        ZeroMemory(&up, sizeof(up));
        up.type = INPUT_KEYBOARD;
        up.ki.wVk = modifiers[i - 1];
        up.ki.dwFlags = KEYEVENTF_KEYUP;
        inputs.push_back(up);
    }
    SendInput(static_cast<UINT>(inputs.size()), &inputs[0], sizeof(INPUT));
}

void TypeForegroundText(const std::wstring& text)
{
    // KEYEVENTF_UNICODE sidesteps the keyboard layout entirely, so text that the
    // current layout cannot type still arrives intact.
    for (size_t i = 0; i < text.size(); ++i)
    {
        INPUT down;
        ZeroMemory(&down, sizeof(down));
        down.type = INPUT_KEYBOARD;
        down.ki.wScan = static_cast<WORD>(text[i]);
        down.ki.dwFlags = KEYEVENTF_UNICODE;
        INPUT up = down;
        up.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        INPUT pair[2] = {down, up};
        SendInput(2, pair, sizeof(INPUT));
    }
}

// Front the window, run the action, then put focus back where it was. A helper
// that leaves the operator's focus somewhere they did not put it has caused a
// side effect of its own, on top of whatever it was asked to do.
struct ForegroundScope
{
    HWND previous;
    bool acquired;

    explicit ForegroundScope(HWND target)
    {
        previous = GetForegroundWindow();
        acquired = BringToForeground(target);
    }

    ~ForegroundScope()
    {
        if (acquired && previous != NULL && IsWindow(previous))
        {
            SetForegroundWindow(previous);
        }
    }
};

struct ClickSpec
{
    UINT downMessage;
    UINT upMessage;
    UINT doubleMessage;
    WPARAM buttonFlag;
    DWORD sendDown;
    DWORD sendUp;
};

bool ResolveClickSpec(const std::string& button, ClickSpec& spec)
{
    if (button.empty() || button == "left")
    {
        spec.downMessage = WM_LBUTTONDOWN;
        spec.upMessage = WM_LBUTTONUP;
        spec.doubleMessage = WM_LBUTTONDBLCLK;
        spec.buttonFlag = MK_LBUTTON;
        spec.sendDown = MOUSEEVENTF_LEFTDOWN;
        spec.sendUp = MOUSEEVENTF_LEFTUP;
        return true;
    }
    if (button == "right")
    {
        spec.downMessage = WM_RBUTTONDOWN;
        spec.upMessage = WM_RBUTTONUP;
        spec.doubleMessage = WM_RBUTTONDBLCLK;
        spec.buttonFlag = MK_RBUTTON;
        spec.sendDown = MOUSEEVENTF_RIGHTDOWN;
        spec.sendUp = MOUSEEVENTF_RIGHTUP;
        return true;
    }
    if (button == "middle")
    {
        spec.downMessage = WM_MBUTTONDOWN;
        spec.upMessage = WM_MBUTTONUP;
        spec.doubleMessage = WM_MBUTTONDBLCLK;
        spec.buttonFlag = MK_MBUTTON;
        spec.sendDown = MOUSEEVENTF_MIDDLEDOWN;
        spec.sendUp = MOUSEEVENTF_MIDDLEUP;
        return true;
    }
    return false;
}

// Center of the element to act on, in screen coordinates.
bool ElementCenter(IUIAutomationElement* element, POINT& center)
{
    RECT rect;
    if (FAILED(element->get_CurrentBoundingRectangle(&rect)))
    {
        return false;
    }
    if (rect.right <= rect.left || rect.bottom <= rect.top)
    {
        return false;
    }
    center.x = rect.left + (rect.right - rect.left) / 2;
    center.y = rect.top + (rect.bottom - rect.top) / 2;
    return true;
}

bool PostBackgroundClick(HWND hwnd, POINT screenPoint, const ClickSpec& spec, int clicks)
{
    POINT clientPoint;
    const HWND target = ChildAtScreenPoint(hwnd, screenPoint, clientPoint);
    if (target == NULL)
    {
        return false;
    }
    const LPARAM position = MAKELPARAM(clientPoint.x, clientPoint.y);
    // Move first: apps that track hover state before a press need to see it.
    PostMessageW(target, WM_MOUSEMOVE, 0, position);
    PostMessageW(target, spec.downMessage, spec.buttonFlag, position);
    PostMessageW(target, spec.upMessage, 0, position);

    // A double click is NOT two clicks. Windows synthesizes WM_*BUTTONDBLCLK
    // from the timing of real input, which posted messages do not have, so
    // posting down/up twice delivers two separate single clicks -- and an app
    // that distinguishes them (most do) acts twice instead of once. The second
    // press has to be the explicit double-click message.
    for (int extra = 1; extra < clicks; ++extra)
    {
        PostMessageW(target, spec.doubleMessage, spec.buttonFlag, position);
        PostMessageW(target, spec.upMessage, 0, position);
    }
    return true;
}

void SendForegroundClick(POINT screenPoint, const ClickSpec& spec, int clicks,
                         const std::vector<WORD>& modifiers)
{
    const int originX = GetSystemMetrics(SM_XVIRTUALSCREEN);
    const int originY = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const int width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    const int height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (width <= 1 || height <= 1)
    {
        return;
    }

    for (size_t i = 0; i < modifiers.size(); ++i)
    {
        INPUT down;
        ZeroMemory(&down, sizeof(down));
        down.type = INPUT_KEYBOARD;
        down.ki.wVk = modifiers[i];
        SendInput(1, &down, sizeof(INPUT));
    }

    INPUT move;
    ZeroMemory(&move, sizeof(move));
    move.type = INPUT_MOUSE;
    move.mi.dx = static_cast<LONG>((static_cast<double>(screenPoint.x - originX) * 65535.0) /
                                   (width - 1));
    move.mi.dy = static_cast<LONG>((static_cast<double>(screenPoint.y - originY) * 65535.0) /
                                   (height - 1));
    move.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    SendInput(1, &move, sizeof(INPUT));

    for (int i = 0; i < clicks; ++i)
    {
        INPUT press[2];
        ZeroMemory(press, sizeof(press));
        press[0].type = INPUT_MOUSE;
        press[0].mi.dwFlags = spec.sendDown;
        press[1].type = INPUT_MOUSE;
        press[1].mi.dwFlags = spec.sendUp;
        SendInput(2, press, sizeof(INPUT));
    }

    for (size_t i = modifiers.size(); i > 0; --i)
    {
        INPUT up;
        ZeroMemory(&up, sizeof(up));
        up.type = INPUT_KEYBOARD;
        up.ki.wVk = modifiers[i - 1];
        up.ki.dwFlags = KEYEVENTF_KEYUP;
        SendInput(1, &up, sizeof(INPUT));
    }
}

// --- Op: key ----------------------------------------------------------------
//
// Keyboard is where most real desktop work happens (ctrl+s, tab, escape), and
// UI Automation has no pattern for "press a key" -- so this starts at the
// background rung. Neither rung can prove the app acted, so neither claims to.
void RunKey(HWND hwnd, const std::string& combo, DeliveryMode delivery, bool allowForeground)
{
    std::vector<WORD> modifiers;
    WORD mainKey = 0;
    if (!ParseKeyCombo(combo, modifiers, mainKey))
    {
        EmitFailure("bad_key_combo",
                    "could not read that as a key combo; use forms like 'ctrl+s', 'tab', 'f5'");
        return;
    }

    if (delivery != kDeliveryForeground)
    {
        const HWND focused = FocusedChildOf(hwnd);
        if (focused != NULL)
        {
            // A posted key cannot carry held modifiers -- the receiving app reads
            // modifier state from the real keyboard, which is untouched here. So
            // a combo is only honest on the foreground rung.
            if (modifiers.empty())
            {
                // lParam has to carry the scan code. The receiving app turns a
                // key message into a character through TranslateMessage, which
                // reads the scan code out of lParam -- posting 0 there delivers
                // a keystroke that arrives and produces nothing, which looks
                // exactly like the rung not working.
                const UINT scan = MapVirtualKeyW(mainKey, MAPVK_VK_TO_VSC);
                const LPARAM downParam = static_cast<LPARAM>(1 | (scan << 16));
                const LPARAM upParam =
                    static_cast<LPARAM>(1 | (scan << 16) | (1u << 30) | (1u << 31));
                PostMessageW(focused, WM_KEYDOWN, mainKey, downParam);
                PostMessageW(focused, WM_KEYUP, mainKey, upParam);
                EmitVerdict(true, "unverifiable", false, "background",
                            "key posted to the focused control without taking focus");
                return;
            }
            if (delivery == kDeliveryBackground)
            {
                EmitFailure("modifiers_need_foreground",
                            "a modifier combo cannot be delivered in the background; the app "
                            "reads modifier state from the real keyboard");
                return;
            }
        }
        else if (delivery == kDeliveryBackground)
        {
            EmitFailure("background_unavailable", "the window exposes no focused control");
            return;
        }
    }

    if (!allowForeground)
    {
        EmitFailure("uia_unsupported",
                    "this key needs the foreground rung; re-run with --allow-foreground");
        return;
    }

    ForegroundScope scope(hwnd);
    if (!scope.acquired)
    {
        EmitFailure("foreground_denied",
                    "Windows refused to bring the window forward; the keys would have gone to "
                    "whatever is actually in front");
        return;
    }
    PressForegroundKeys(modifiers, mainKey);
    EmitVerdict(true, "unverifiable", false, "foreground", "key sent as real keyboard input");
}

// --- Op: type ---------------------------------------------------------------
//
// Free text into whatever holds focus.
//
// Two things make this the weaker choice whenever a specific field is the
// target. There is no element to read back, so it is unverifiable by
// construction. And the text lands AT THE CARET, wherever that happens to be --
// after a programmatic set_value the caret sits at position 0, so typing then
// PREPENDS rather than appends. Nothing here can see the caret to warn about it.
// set_value replaces the whole field and can prove it did.
void RunType(HWND hwnd, const std::string& text, DeliveryMode delivery, bool allowForeground)
{
    if (text.empty())
    {
        EmitFailure("bad_request", "text is required");
        return;
    }
    const std::wstring wide = WideFromUtf8(text);

    if (delivery != kDeliveryForeground)
    {
        const HWND focused = FocusedChildOf(hwnd);
        if (focused != NULL)
        {
            for (size_t i = 0; i < wide.size(); ++i)
            {
                PostMessageW(focused, WM_CHAR, static_cast<WPARAM>(wide[i]), 0);
            }
            EmitVerdict(true, "unverifiable", false, "background",
                        "text posted to the focused control without taking focus");
            return;
        }
        if (delivery == kDeliveryBackground)
        {
            EmitFailure("background_unavailable", "the window exposes no focused control");
            return;
        }
    }

    if (!allowForeground)
    {
        EmitFailure("uia_unsupported",
                    "typing here needs the foreground rung; re-run with --allow-foreground");
        return;
    }

    ForegroundScope scope(hwnd);
    if (!scope.acquired)
    {
        EmitFailure("foreground_denied",
                    "Windows refused to bring the window forward; the text would have gone to "
                    "whatever is actually in front");
        return;
    }
    TypeForegroundText(wide);
    EmitVerdict(true, "unverifiable", false, "foreground", "text sent as real keyboard input");
}

// --- Op: click --------------------------------------------------------------
//
// A single click on a plain button is better served by invoke (rung 1, provable).
// This exists for what invoke cannot express: right-click, double-click, held
// modifiers -- and for controls that expose no InvokePattern at all.
void RunClick(IUIAutomation* automation, HWND hwnd, int ref, const std::string& snapshotId,
              const std::string& button, int clicks, const std::vector<WORD>& modifiers,
              DeliveryMode delivery, bool allowForeground)
{
    ClickSpec spec;
    if (!ResolveClickSpec(button, spec))
    {
        EmitFailure("bad_request", "button must be left, right or middle");
        return;
    }
    if (clicks < 1 || clicks > 3)
    {
        EmitFailure("bad_request", "clicks must be 1, 2 or 3");
        return;
    }

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

    POINT center;
    if (!ElementCenter(elements[index].element, center))
    {
        EmitFailure("element_not_on_screen", "the element has no usable on-screen rectangle");
        ReleaseElements(elements);
        return;
    }

    if (delivery != kDeliveryForeground)
    {
        // Modifiers are read from the real keyboard, so a posted click cannot
        // carry them; say so rather than dropping them silently and reporting a
        // plain click as if it were the modified one that was asked for.
        if (!modifiers.empty())
        {
            if (delivery == kDeliveryBackground)
            {
                EmitFailure("modifiers_need_foreground",
                            "a modified click cannot be delivered in the background");
                ReleaseElements(elements);
                return;
            }
        }
        else if (PostBackgroundClick(hwnd, center, spec, clicks))
        {
            EmitVerdict(true, "unverifiable", false, "background",
                        "click posted to the target window without taking focus or moving the "
                        "cursor");
            ReleaseElements(elements);
            return;
        }
        else if (delivery == kDeliveryBackground)
        {
            EmitFailure("background_unavailable", "no child window at the element position");
            ReleaseElements(elements);
            return;
        }
    }

    if (!allowForeground)
    {
        EmitFailure("uia_unsupported",
                    "this click needs the foreground rung; re-run with --allow-foreground");
        ReleaseElements(elements);
        return;
    }

    ForegroundScope scope(hwnd);
    if (!scope.acquired)
    {
        EmitFailure("foreground_denied",
                    "Windows refused to bring the window forward; the click would have landed on "
                    "whatever is actually in front");
        ReleaseElements(elements);
        return;
    }
    POINT covered;
    covered.x = center.x;
    covered.y = center.y;
    const HWND atPoint = WindowFromPoint(covered);
    if (atPoint == NULL || GetAncestor(atPoint, GA_ROOT) != GetAncestor(hwnd, GA_ROOT))
    {
        EmitFailure("element_obscured", "another window covers the click point");
        ReleaseElements(elements);
        return;
    }
    SendForegroundClick(center, spec, clicks, modifiers);
    EmitVerdict(true, "unverifiable", false, "foreground", "click sent as real mouse input");
    ReleaseElements(elements);
}

// --- Op: scroll -------------------------------------------------------------
//
// The one input action with a real UI Automation pattern behind it, so unlike
// the rest of this file it can start on a rung that reports success.
void RunScroll(IUIAutomation* automation, HWND hwnd, int ref, const std::string& snapshotId,
               const std::string& direction, int amount, DeliveryMode delivery,
               bool allowForeground)
{
    if (direction != "up" && direction != "down" && direction != "left" && direction != "right")
    {
        EmitFailure("bad_request", "direction must be up, down, left or right");
        return;
    }
    if (amount < 1 || amount > 30)
    {
        EmitFailure("bad_request", "amount must be between 1 and 30");
        return;
    }

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

    if (delivery == kDeliveryAuto)
    {
        IUIAutomationScrollPattern* pattern = NULL;
        if (SUCCEEDED(element->GetCurrentPatternAs(UIA_ScrollPatternId,
                                                   __uuidof(IUIAutomationScrollPattern),
                                                   reinterpret_cast<void**>(&pattern))) &&
            pattern != NULL)
        {
            ScrollAmount horizontal = ScrollAmount_NoAmount;
            ScrollAmount vertical = ScrollAmount_NoAmount;
            if (direction == "up")
            {
                vertical = ScrollAmount_SmallDecrement;
            }
            else if (direction == "down")
            {
                vertical = ScrollAmount_SmallIncrement;
            }
            else if (direction == "left")
            {
                horizontal = ScrollAmount_SmallDecrement;
            }
            else
            {
                horizontal = ScrollAmount_SmallIncrement;
            }

            // Read the position back: a scroll that was already at the end
            // reports success while changing nothing, and that is a no-op the
            // caller needs to know about rather than a completed scroll.
            double before = 0.0;
            const bool readBefore =
                SUCCEEDED((direction == "up" || direction == "down")
                              ? pattern->get_CurrentVerticalScrollPercent(&before)
                              : pattern->get_CurrentHorizontalScrollPercent(&before));

            HRESULT hr = S_OK;
            for (int i = 0; i < amount && SUCCEEDED(hr); ++i)
            {
                hr = pattern->Scroll(horizontal, vertical);
            }
            if (SUCCEEDED(hr))
            {
                double after = 0.0;
                const bool readAfter =
                    SUCCEEDED((direction == "up" || direction == "down")
                                  ? pattern->get_CurrentVerticalScrollPercent(&after)
                                  : pattern->get_CurrentHorizontalScrollPercent(&after));
                pattern->Release();
                if (readBefore && readAfter)
                {
                    if (after != before)
                    {
                        EmitVerdict(true, "confirmed", true, "uia_scroll",
                                    "scroll position changed and was read back");
                    }
                    else
                    {
                        EmitVerdict(false, "suspected_noop", false, "uia_scroll",
                                    "the scroll position did not move; it is already at that end");
                    }
                }
                else
                {
                    EmitVerdict(true, "unverifiable", false, "uia_scroll",
                                "ScrollPattern reported success but the position could not be read");
                }
                ReleaseElements(elements);
                return;
            }
            pattern->Release();
        }
    }

    POINT center;
    if (!ElementCenter(element, center))
    {
        EmitFailure("element_not_on_screen", "the element has no usable on-screen rectangle");
        ReleaseElements(elements);
        return;
    }
    const int ticks = ((direction == "up" || direction == "left") ? 1 : -1) * amount * WHEEL_DELTA;
    const bool horizontalWheel = (direction == "left" || direction == "right");

    if (delivery != kDeliveryForeground)
    {
        POINT clientPoint;
        const HWND target = ChildAtScreenPoint(hwnd, center, clientPoint);
        if (target != NULL)
        {
            // Wheel messages carry SCREEN coordinates, unlike the button ones.
            PostMessageW(target, horizontalWheel ? WM_MOUSEHWHEEL : WM_MOUSEWHEEL,
                         MAKEWPARAM(0, static_cast<short>(ticks)),
                         MAKELPARAM(center.x, center.y));
            EmitVerdict(true, "unverifiable", false, "background",
                        "wheel posted to the target window without taking focus");
            ReleaseElements(elements);
            return;
        }
        if (delivery == kDeliveryBackground)
        {
            EmitFailure("background_unavailable", "no child window at the element position");
            ReleaseElements(elements);
            return;
        }
    }

    if (!allowForeground)
    {
        EmitFailure("uia_unsupported",
                    "this scroll needs the foreground rung; re-run with --allow-foreground");
        ReleaseElements(elements);
        return;
    }

    ForegroundScope scope(hwnd);
    if (!scope.acquired)
    {
        EmitFailure("foreground_denied", "Windows refused to bring the window forward");
        ReleaseElements(elements);
        return;
    }
    INPUT wheel;
    ZeroMemory(&wheel, sizeof(wheel));
    wheel.type = INPUT_MOUSE;
    wheel.mi.mouseData = static_cast<DWORD>(ticks);
    wheel.mi.dwFlags = horizontalWheel ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
    SendInput(1, &wheel, sizeof(INPUT));
    EmitVerdict(true, "unverifiable", false, "foreground", "wheel sent as real mouse input");
    ReleaseElements(elements);
}

// --- Op: drag ---------------------------------------------------------------
//
// Foreground only, and deliberately so: a drag is a timed sequence of real
// pointer state that posted messages do not reproduce in most apps. Offering a
// background rung here would mostly produce silent no-ops.
void RunDrag(IUIAutomation* automation, HWND hwnd, int fromRef, int toRef,
             const std::string& snapshotId, bool allowForeground)
{
    if (!allowForeground)
    {
        EmitFailure("uia_unsupported",
                    "a drag is real pointer input; re-run with --allow-foreground");
        return;
    }

    std::vector<ElementInfo> elements;
    size_t fromIndex = 0;
    std::string code;
    std::string detail;
    if (!ResolveRef(automation, hwnd, fromRef, snapshotId, elements, fromIndex, code, detail))
    {
        EmitFailure(code, detail);
        ReleaseElements(elements);
        return;
    }
    if (toRef < 1 || toRef > static_cast<int>(elements.size()))
    {
        EmitFailure("element_ref_unknown", "the destination ref is not in this snapshot");
        ReleaseElements(elements);
        return;
    }
    const size_t toIndex = static_cast<size_t>(toRef - 1);

    POINT from;
    POINT to;
    if (!ElementCenter(elements[fromIndex].element, from) ||
        !ElementCenter(elements[toIndex].element, to))
    {
        EmitFailure("element_not_on_screen", "both ends of a drag must be on screen");
        ReleaseElements(elements);
        return;
    }

    ForegroundScope scope(hwnd);
    if (!scope.acquired)
    {
        EmitFailure("foreground_denied", "Windows refused to bring the window forward");
        ReleaseElements(elements);
        return;
    }

    ClickSpec spec;
    ResolveClickSpec("left", spec);
    const std::vector<WORD> none;
    const int originX = GetSystemMetrics(SM_XVIRTUALSCREEN);
    const int originY = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const int width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    const int height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (width <= 1 || height <= 1)
    {
        EmitFailure("no_screen_metrics", "no virtual screen metrics");
        ReleaseElements(elements);
        return;
    }

    // Move, press, glide, release. The intermediate moves matter: apps that
    // start a drag on the first move after a press see nothing from a single
    // jump straight to the destination.
    const int kSteps = 12;
    for (int step = 0; step <= kSteps; ++step)
    {
        const long x = from.x + ((to.x - from.x) * step) / kSteps;
        const long y = from.y + ((to.y - from.y) * step) / kSteps;
        INPUT move;
        ZeroMemory(&move, sizeof(move));
        move.type = INPUT_MOUSE;
        move.mi.dx = static_cast<LONG>((static_cast<double>(x - originX) * 65535.0) / (width - 1));
        move.mi.dy = static_cast<LONG>((static_cast<double>(y - originY) * 65535.0) / (height - 1));
        move.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        SendInput(1, &move, sizeof(INPUT));
        if (step == 0)
        {
            INPUT press;
            ZeroMemory(&press, sizeof(press));
            press.type = INPUT_MOUSE;
            press.mi.dwFlags = spec.sendDown;
            SendInput(1, &press, sizeof(INPUT));
        }
        Sleep(12);
    }
    INPUT release;
    ZeroMemory(&release, sizeof(release));
    release.type = INPUT_MOUSE;
    release.mi.dwFlags = spec.sendUp;
    SendInput(1, &release, sizeof(INPUT));

    EmitVerdict(true, "unverifiable", false, "foreground",
                "drag delivered as real pointer input; nothing here proves the app accepted it");
    ReleaseElements(elements);
}

// --- Op: focus --------------------------------------------------------------
//
// Kept separate from the input actions because it is a persistent, visible
// change to the operator's desktop rather than a momentary one -- worth its own
// call and its own approval instead of riding along inside a click.
void RunFocus(HWND hwnd, bool allowForeground)
{
    if (!allowForeground)
    {
        EmitFailure("uia_unsupported",
                    "raising a window changes what the operator is looking at; re-run with "
                    "--allow-foreground");
        return;
    }
    const HWND previous = GetForegroundWindow();
    if (!BringToForeground(hwnd))
    {
        EmitFailure("foreground_denied", "Windows refused to bring the window forward");
        return;
    }
    // Deliberately NOT restored: raising is the whole point of this op.
    const bool changed = (previous != GetForegroundWindow());
    EmitVerdict(true, changed ? "confirmed" : "unverifiable", false, "foreground",
                changed ? "the window is now in front" : "the window was already in front");
}

// --- Op: list_apps ----------------------------------------------------------
//
// Windows grouped by owning program. A model that wants "the browser" should not
// have to infer it from a list of window titles.
void RunListApps()
{
    std::vector<WindowInfo> windows;
    EnumWindows(CollectWindow, reinterpret_cast<LPARAM>(&windows));

    std::vector<std::string> names;
    std::vector<int> counts;
    std::vector<std::string> samples;
    for (size_t i = 0; i < windows.size(); ++i)
    {
        const std::string& process = windows[i].process;
        if (process.empty())
        {
            continue;
        }
        bool found = false;
        for (size_t k = 0; k < names.size(); ++k)
        {
            if (names[k] == process)
            {
                counts[k] += 1;
                found = true;
                break;
            }
        }
        if (!found)
        {
            names.push_back(process);
            counts.push_back(1);
            samples.push_back(windows[i].title);
        }
    }

    std::ostringstream out;
    out << "{\"ok\":true,\"apps\":[";
    for (size_t i = 0; i < names.size(); ++i)
    {
        if (i > 0)
        {
            out << ",";
        }
        out << "{\"process\":\"" << JsonEscape(names[i]) << "\",\"windowCount\":" << counts[i]
            << ",\"sampleTitle\":\"" << JsonEscape(samples[i]) << "\"}";
    }
    out << "]}";
    std::cout << out.str() << std::endl;
}


// What does the container ACTUALLY hold now? This is the committed state -- the
// value the app will act on -- as opposed to whatever is highlighted in a list
// that may never have been committed.
bool ReadContainerSelection(IUIAutomationElement* container, std::wstring& current)
{
    bool readOk = false;

    IUIAutomationSelectionPattern* selection = NULL;
    if (SUCCEEDED(container->GetCurrentPatternAs(UIA_SelectionPatternId,
                                                 __uuidof(IUIAutomationSelectionPattern),
                                                 reinterpret_cast<void**>(&selection))) &&
        selection != NULL)
    {
        IUIAutomationElementArray* chosen = NULL;
        if (SUCCEEDED(selection->GetCurrentSelection(&chosen)) && chosen != NULL)
        {
            int count = 0;
            chosen->get_Length(&count);
            if (count > 0)
            {
                IUIAutomationElement* first = NULL;
                if (SUCCEEDED(chosen->GetElement(0, &first)) && first != NULL)
                {
                    BSTR nameRaw = NULL;
                    if (SUCCEEDED(first->get_CurrentName(&nameRaw)) && nameRaw != NULL)
                    {
                        current = nameRaw;
                        readOk = true;
                        SysFreeString(nameRaw);
                    }
                    first->Release();
                }
            }
            chosen->Release();
        }
        selection->Release();
    }

    if (!readOk)
    {
        // Fall back to the control's value, which some providers expose instead
        // of a selection.
        IUIAutomationValuePattern* value = NULL;
        if (SUCCEEDED(container->GetCurrentPatternAs(UIA_ValuePatternId,
                                                     __uuidof(IUIAutomationValuePattern),
                                                     reinterpret_cast<void**>(&value))) &&
            value != NULL)
        {
            BSTR raw = NULL;
            if (SUCCEEDED(value->get_CurrentValue(&raw)) && raw != NULL)
            {
                current = raw;
                readOk = true;
                SysFreeString(raw);
            }
            value->Release();
        }
    }

    return readOk;
}

// --- Op: select -------------------------------------------------------------
//
// Choose an option in a combo box / list by its label, WITHOUT opening the menu.
// Opening a dropdown means a popup window, a focus change, and a second click
// aimed at something that did not exist when the snapshot was taken -- three
// chances to act on the wrong thing. SelectionItemPattern skips all of it, and
// unlike a click it can be read back: IsSelected afterwards is proof.
void RunSelect(IUIAutomation* automation, HWND hwnd, int ref, const std::string& snapshotId,
               const std::string& option)
{
    if (option.empty())
    {
        EmitFailure("bad_request", "option is required");
        return;
    }

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

    IUIAutomationElement* container = elements[index].element;
    IUIAutomationCondition* anything = NULL;
    IUIAutomationElementArray* found = NULL;
    IUIAutomationElement* match = NULL;
    IUIAutomationExpandCollapsePattern* expanded = NULL;
    const std::wstring wanted = WideFromUtf8(option);
    int candidates = 0;
    int listIndex = -1;
    int matchIndex = -1;
    bool openedMenu = false;

    while (true)
    {
        if (FAILED(automation->CreateTrueCondition(&anything)) || anything == NULL)
        {
            EmitFailure("uia_unavailable", "could not build an element query");
            break;
        }
        if (FAILED(container->FindAll(TreeScope_Subtree, anything, &found)) || found == NULL)
        {
            EmitFailure("uia_unsupported", "the control did not answer an option query");
            break;
        }
        int count = 0;
        found->get_Length(&count);
        candidates = 0;
        listIndex = -1;
        for (int i = 0; i < count; ++i)
        {
            IUIAutomationElement* node = NULL;
            if (FAILED(found->GetElement(i, &node)) || node == NULL)
            {
                continue;
            }
            BSTR nameRaw = NULL;
            node->get_CurrentName(&nameRaw);
            const std::wstring name(nameRaw == NULL ? L"" : nameRaw);
            if (nameRaw != NULL)
            {
                SysFreeString(nameRaw);
            }
            CONTROLTYPEID nodeType = 0;
            node->get_CurrentControlType(&nodeType);
            if (nodeType == UIA_ListItemControlTypeId)
            {
                listIndex += 1;
            }
            if (name == wanted)
            {
                if (match == NULL)
                {
                    candidates = 1;
                    matchIndex = (nodeType == UIA_ListItemControlTypeId) ? listIndex : -1;
                    match = node;
                    continue;
                }
                // A combo surfaces the same item through more than one path once
                // it is open, so two hits by name is not two options. Ask UIA
                // whether these are actually the same element before calling it
                // ambiguous -- otherwise every dropdown looks ambiguous and none
                // can be used.
                BOOL same = FALSE;
                if (FAILED(automation->CompareElements(match, node, &same)) || same == FALSE)
                {
                    candidates += 1;
                }
            }
            node->Release();
        }

        if (match == NULL && expanded == NULL)
        {
            // A closed Win32 dropdown has no list to search: its items do not
            // exist as elements until it opens. So open it, look again, and
            // close it afterwards. Selecting without opening is still preferred
            // -- an open menu is a popup that did not exist when the snapshot
            // was taken -- but refusing outright would make dropdowns
            // undrivable, which is worse.
            if (SUCCEEDED(container->GetCurrentPatternAs(
                    UIA_ExpandCollapsePatternId, __uuidof(IUIAutomationExpandCollapsePattern),
                    reinterpret_cast<void**>(&expanded))) &&
                expanded != NULL && SUCCEEDED(expanded->Expand()))
            {
                Sleep(120);
                found->Release();
                found = NULL;
                if (SUCCEEDED(container->FindAll(TreeScope_Subtree, anything, &found)) &&
                    found != NULL)
                {
                    openedMenu = true;
                    continue;
                }
            }
        }
        if (match == NULL)
        {
            EmitFailure("option_not_found",
                        "no option with that exact label; take a fresh snapshot and read the "
                        "available options rather than guessing");
            break;
        }
        if (candidates > 1)
        {
            // Two options share a label: picking one would be a coin flip
            // dressed up as a decision.
            EmitFailure("option_ambiguous", "more than one option carries that label");
            break;
        }

        IUIAutomationSelectionItemPattern* pattern = NULL;
        if (FAILED(match->GetCurrentPatternAs(UIA_SelectionItemPatternId,
                                              __uuidof(IUIAutomationSelectionItemPattern),
                                              reinterpret_cast<void**>(&pattern))) ||
            pattern == NULL)
        {
            EmitFailure("uia_unsupported", "that option cannot be selected directly");
            break;
        }
        const HRESULT hr = pattern->Select();
        pattern->Release();
        if (FAILED(hr))
        {
            EmitVerdict(false, "suspected_noop", false, "uia_select", "Select failed");
            break;
        }

        // Close the menu BEFORE checking, then ask the CONTAINER what it holds.
        //
        // Reading IsSelected off the item was wrong in the worst possible
        // direction: it reports the highlight in the open list, so it said
        // "selected, verified" for a combo whose real value never changed --
        // collapsing dismisses the list like Escape rather than committing it.
        // The container's own selection is the state the app will act on, and
        // it is the only thing worth calling proof.
        std::wstring current;
        if (expanded != NULL)
        {
            expanded->Collapse();
            Sleep(80);
        }
        bool readOk = ReadContainerSelection(container, current);

        // Select() only highlights in some providers -- a classic Win32 combo
        // among them. The default action is what a click on the item would do,
        // which is what actually commits. Trying it only after the check means
        // a provider where Select() already worked is left alone.
        if (readOk && current != wanted)
        {
            IUIAutomationLegacyIAccessiblePattern* legacy = NULL;
            if (SUCCEEDED(match->GetCurrentPatternAs(
                    UIA_LegacyIAccessiblePatternId,
                    __uuidof(IUIAutomationLegacyIAccessiblePattern),
                    reinterpret_cast<void**>(&legacy))) &&
                legacy != NULL)
            {
                if (expanded != NULL)
                {
                    expanded->Expand();
                    Sleep(80);
                }
                legacy->DoDefaultAction();
                legacy->Release();
                Sleep(80);
                if (expanded != NULL)
                {
                    expanded->Collapse();
                    Sleep(80);
                }
                readOk = ReadContainerSelection(container, current);
            }
        }

        // Last rung for classic Win32 combos, which ignore both UIA routes above.
        // CB_SETCURSEL takes an INDEX, so nothing crosses the process boundary as
        // a pointer -- the string-taking messages are not marshalled and reaching
        // for them would mean writing into another process's memory.
        //
        // CB_SETCURSEL deliberately does not notify the parent, so the app would
        // never learn its own value changed. Posting the CBN_SELCHANGE the
        // control itself would have sent is the difference between driving the
        // control and leaving the app disagreeing with its own UI.
        if (readOk && current != wanted && matchIndex >= 0)
        {
            UIA_HWND nativeRaw = NULL;
            if (SUCCEEDED(container->get_CurrentNativeWindowHandle(&nativeRaw)) &&
                nativeRaw != NULL)
            {
                const HWND comboWindow = static_cast<HWND>(nativeRaw);
                wchar_t className[64];
                if (GetClassNameW(comboWindow, className, 64) > 0 &&
                    _wcsicmp(className, L"ComboBox") == 0)
                {
                    if (expanded != NULL)
                    {
                        expanded->Collapse();
                    }
                    SendMessageW(comboWindow, CB_SETCURSEL, static_cast<WPARAM>(matchIndex), 0);
                    const HWND parent = GetParent(comboWindow);
                    if (parent != NULL)
                    {
                        PostMessageW(parent, WM_COMMAND,
                                     MAKEWPARAM(GetDlgCtrlID(comboWindow), CBN_SELCHANGE),
                                     reinterpret_cast<LPARAM>(comboWindow));
                    }
                    Sleep(80);
                    readOk = ReadContainerSelection(container, current);
                }
            }
        }

        if (expanded != NULL)
        {
            expanded->Release();
            expanded = NULL;
        }

        if (!readOk)
        {
            EmitVerdict(true, "unverifiable", false, "uia_select",
                        "the selection was made but the control would not say what it now holds");
        }
        else if (current == wanted)
        {
            EmitVerdict(true, "confirmed", true, "uia_select",
                        openedMenu ? "the control now holds that option; the menu had to be "
                                     "opened to reach it"
                                   : "the control now holds that option");
        }
        else
        {
            EmitVerdict(false, "suspected_noop", false, "uia_select",
                        "the control still holds a different option; the selection did not "
                        "commit");
        }
        break;
    }

    if (expanded != NULL)
    {
        // Leave the menu as it was found. An open dropdown swallows the next
        // click the operator makes.
        expanded->Collapse();
        expanded->Release();
    }
    if (match != NULL)
    {
        match->Release();
    }
    if (found != NULL)
    {
        found->Release();
    }
    if (anything != NULL)
    {
        anything->Release();
    }
    ReleaseElements(elements);
}

// --- Op: toggle -------------------------------------------------------------
//
// Checkboxes. A click would flip whatever state the box is in, which means
// "check this" and "click this" are different requests -- a click on an already
// checked box unchecks it. This takes the DESIRED state and reads the result
// back, so asking for checked twice is idempotent instead of a toggle.
void RunToggle(IUIAutomation* automation, HWND hwnd, int ref, const std::string& snapshotId,
               const std::string& desired)
{
    if (desired != "on" && desired != "off" && desired != "toggle")
    {
        EmitFailure("bad_request", "state must be on, off or toggle");
        return;
    }

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

    IUIAutomationTogglePattern* pattern = NULL;
    if (FAILED(elements[index].element->GetCurrentPatternAs(
            UIA_TogglePatternId, __uuidof(IUIAutomationTogglePattern),
            reinterpret_cast<void**>(&pattern))) ||
        pattern == NULL)
    {
        EmitFailure("uia_unsupported", "that control does not toggle");
        ReleaseElements(elements);
        return;
    }

    ToggleState state = ToggleState_Indeterminate;
    if (FAILED(pattern->get_CurrentToggleState(&state)))
    {
        pattern->Release();
        EmitFailure("uia_unsupported", "the control would not report its state");
        ReleaseElements(elements);
        return;
    }

    const ToggleState wanted = (desired == "on") ? ToggleState_On : ToggleState_Off;
    if (desired != "toggle" && state == wanted)
    {
        // Already there. Saying "confirmed" would be a lie about having acted,
        // and "noop" would read as a failure -- it is neither.
        EmitVerdict(true, "confirmed", true, "uia_toggle",
                    "the control was already in the requested state; nothing was changed");
        pattern->Release();
        ReleaseElements(elements);
        return;
    }

    HRESULT hr = pattern->Toggle();
    // Tri-state controls cycle, so one Toggle may land on indeterminate rather
    // than the state that was asked for.
    for (int attempt = 0; attempt < 2 && SUCCEEDED(hr) && desired != "toggle"; ++attempt)
    {
        ToggleState now = ToggleState_Indeterminate;
        if (FAILED(pattern->get_CurrentToggleState(&now)) || now == wanted)
        {
            break;
        }
        hr = pattern->Toggle();
    }

    if (FAILED(hr))
    {
        pattern->Release();
        EmitVerdict(false, "suspected_noop", false, "uia_toggle", "Toggle failed");
        ReleaseElements(elements);
        return;
    }

    ToggleState after = ToggleState_Indeterminate;
    const bool readOk = SUCCEEDED(pattern->get_CurrentToggleState(&after));
    pattern->Release();

    if (!readOk)
    {
        EmitVerdict(true, "unverifiable", false, "uia_toggle",
                    "Toggle reported success but the state could not be read back");
    }
    else if (desired == "toggle")
    {
        EmitVerdict(true, after != state ? "confirmed" : "suspected_noop", after != state,
                    "uia_toggle",
                    after != state ? "the state changed and was read back"
                                   : "the state did not change");
    }
    else if (after == wanted)
    {
        EmitVerdict(true, "confirmed", true, "uia_toggle", "the requested state was read back");
    }
    else
    {
        EmitVerdict(false, "suspected_noop", false, "uia_toggle",
                    "the control did not reach the requested state");
    }
    ReleaseElements(elements);
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

    if (op == "list_apps")
    {
        RunListApps();
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
    const DeliveryMode delivery = ParseDelivery(JsonReadString(command, "delivery"));

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
    else if (op == "click")
    {
        std::vector<WORD> modifiers;
        std::string modifierRaw;
        ExtractTopLevelRaw(command, "modifiers", modifierRaw);
        ParseModifierList(modifierRaw, modifiers);
        const int clicks = static_cast<int>(JsonReadNumber(command, "clicks", 1));
        RunClick(automation, hwnd, ref, snapshotId, JsonReadString(command, "button"), clicks,
                 modifiers, delivery, allowForeground);
    }
    else if (op == "scroll")
    {
        const int amount = static_cast<int>(JsonReadNumber(command, "amount", 3));
        RunScroll(automation, hwnd, ref, snapshotId, JsonReadString(command, "direction"), amount,
                  delivery, allowForeground);
    }
    else if (op == "key")
    {
        RunKey(hwnd, JsonReadString(command, "keys"), delivery, allowForeground);
    }
    else if (op == "type")
    {
        RunType(hwnd, JsonReadString(command, "text"), delivery, allowForeground);
    }
    else if (op == "drag")
    {
        const int toRef = static_cast<int>(JsonReadNumber(command, "toRef", 0));
        RunDrag(automation, hwnd, ref, toRef, snapshotId, allowForeground);
    }
    else if (op == "focus")
    {
        RunFocus(hwnd, allowForeground);
    }
    else if (op == "select")
    {
        RunSelect(automation, hwnd, ref, snapshotId, JsonReadString(command, "option"));
    }
    else if (op == "toggle")
    {
        std::string state = JsonReadString(command, "state");
        if (state.empty())
        {
            state = "toggle";
        }
        RunToggle(automation, hwnd, ref, snapshotId, state);
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

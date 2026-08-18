// Test fixture window for aoi_desktop_input.exe.
//
// The input helper cannot be tested against the operator's real desktop: driving
// their live Chrome or Settings to prove a click landed is exactly the kind of
// side effect the helper exists to keep under control. So the tests get their
// own window, holding one control for each branch of the contract:
//
//   "Click Me"   button   -> the click rungs. Its caption stays STABLE (so the
//                            snapshot id survives) and the tally static records
//                            what arrived: left / right / double.
//   "Rename Me"  button   -> changes its own caption when clicked, which retires
//                            the snapshot id and makes the stale-ref refusal
//                            testable.
//   "Message:"   edit     -> set_value read-back, and the keyboard rungs. It
//                            holds focus at startup so background key/text
//                            messages have a deterministic destination.
//   "Password:"  edit     -> ES_PASSWORD, must be REFUSED, never typed into.
//   "Disabled"   button   -> WS_DISABLED, must be refused as a no-op.
//   tally        static   -> "L:n R:n D:n". Not an interactable control type, so
//                            reading it never disturbs the snapshot id.
//   "Notes"      edit     -> multiline + WS_VSCROLL, prefilled past the bottom,
//                            so scrolling it has somewhere to go.
//   "Enabled"    checkbox -> toggle, whose state can be read back.
//   combo box             -> select by label, likewise readable back. Both exist
//                            because a control that can only be clicked can
//                            never be more than "unverifiable".
//
// The tally is what makes the background rung testable at all: the helper
// reports a posted click as unverifiable BECAUSE it cannot see whether the app
// acted. The fixture can, so the test asserts what the helper honestly will not.
//
// Run with --title <text> so a test run can find its own window even if another
// copy is open. Exits when the window closes.
//
// Build: test/run-tests.ps1 builds this alongside the helper.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <cstdio>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

namespace
{

const int kIdClickMe = 101;
const int kIdMessage = 102;
const int kIdPassword = 103;
const int kIdDisabled = 104;
const int kIdTally = 105;
const int kIdRenameMe = 106;
const int kIdNotes = 107;
const int kIdCheck = 108;
const int kIdCombo = 109;
const int kIdExtra = 110;

WNDPROC g_buttonProc = NULL;
HWND g_renameMe = NULL;
HWND g_tally = NULL;
HWND g_message = NULL;

int g_leftClicks = 0;
int g_rightClicks = 0;
int g_doubleClicks = 0;

void RefreshTally()
{
    if (g_tally == NULL)
    {
        return;
    }
    wchar_t text[64];
    swprintf_s(text, 64, L"L:%d R:%d D:%d", g_leftClicks, g_rightClicks, g_doubleClicks);
    SetWindowTextW(g_tally, text);
}

// The button is subclassed so the tally sees exactly which mouse messages
// arrived. BN_CLICKED alone cannot tell a right-click or a real double-click
// from an ordinary click, and those are precisely what the tests need to
// distinguish.
LRESULT CALLBACK ButtonProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    if (message == WM_RBUTTONDOWN)
    {
        g_rightClicks += 1;
        RefreshTally();
    }
    else if (message == WM_LBUTTONDBLCLK)
    {
        g_doubleClicks += 1;
        RefreshTally();
    }
    return CallWindowProcW(g_buttonProc, hwnd, message, wParam, lParam);
}

LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    LRESULT result = 0;
    switch (message)
    {
    case WM_COMMAND:
    {
        const int id = LOWORD(wParam);
        const int notification = HIWORD(wParam);
        if (id == kIdClickMe)
        {
            if (notification == BN_CLICKED)
            {
                g_leftClicks += 1;
                RefreshTally();
            }
        }
        else if (id == kIdRenameMe && notification == BN_CLICKED && g_renameMe != NULL)
        {
            // Adds a control rather than renaming one. A caption change no
            // longer retires refs -- a Win32 control's accessible name is
            // derived from a neighbouring label and flaps, so identity comes
            // from the automation id. What DOES make ref N mean something else
            // is the set of controls changing, which is what this simulates:
            // a button appearing, the way a dialog or an expanding panel does.
            SetWindowTextW(g_renameMe, L"Renamed!");
            CreateWindowExW(0, L"BUTTON", L"Extra", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON, 288,
                            60, 80, 24, hwnd,
                            reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdExtra)),
                            reinterpret_cast<HINSTANCE>(
                                GetWindowLongPtrW(hwnd, GWLP_HINSTANCE)),
                            NULL);
        }
        break;
    }
    // NOTE: WM_PARENTNOTIFY is deliberately NOT used to count right-clicks.
    // The system sends it for real input; a posted WM_RBUTTONDOWN never
    // produces one, so the background rung would look broken when it is not.
    // The button is subclassed instead, below.
    case WM_CLOSE:
    {
        DestroyWindow(hwnd);
        break;
    }
    case WM_DESTROY:
    {
        PostQuitMessage(0);
        break;
    }
    default:
    {
        result = DefWindowProcW(hwnd, message, wParam, lParam);
        break;
    }
    }
    return result;
}

void AddLabel(HWND parent, const wchar_t* text, int x, int y)
{
    // A static placed immediately before an edit becomes that edit's accessible
    // name, which is how "Password:" reaches the helper's credential check.
    CreateWindowExW(0, L"STATIC", text, WS_CHILD | WS_VISIBLE, x, y, 90, 20, parent, NULL, NULL,
                    NULL);
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR commandLine, int)
{
    std::wstring title = L"Aoi Input Test Fixture";
    {
        const std::wstring args(commandLine == NULL ? L"" : commandLine);
        const size_t flag = args.find(L"--title ");
        if (flag != std::wstring::npos)
        {
            title = args.substr(flag + 8);
            while (!title.empty() && (title[0] == L'"' || title[0] == L' '))
            {
                title.erase(0, 1);
            }
            while (!title.empty() &&
                   (title[title.size() - 1] == L'"' || title[title.size() - 1] == L' '))
            {
                title.erase(title.size() - 1);
            }
        }
    }

    WNDCLASSEXW windowClass;
    ZeroMemory(&windowClass, sizeof(windowClass));
    windowClass.cbSize = sizeof(windowClass);
    windowClass.lpfnWndProc = WindowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursor(NULL, IDC_ARROW);
    windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    windowClass.lpszClassName = L"AoiInputTestFixture";
    if (RegisterClassExW(&windowClass) == 0)
    {
        return 1;
    }

    HWND window = CreateWindowExW(0, L"AoiInputTestFixture", title.c_str(), WS_OVERLAPPEDWINDOW,
                                  CW_USEDEFAULT, CW_USEDEFAULT, 460, 420, NULL, NULL, instance,
                                  NULL);
    if (window == NULL)
    {
        return 1;
    }

    // BS_NOTIFY is what makes BN_DBLCLK arrive at all.
    HWND clickMe = CreateWindowExW(
        0, L"BUTTON", L"Click Me", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON | BS_NOTIFY, 16, 16,
        120, 30, window, reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdClickMe)), instance,
        NULL);
    g_buttonProc = reinterpret_cast<WNDPROC>(
        SetWindowLongPtrW(clickMe, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(ButtonProc)));

    g_renameMe = CreateWindowExW(0, L"BUTTON", L"Rename Me",
                                 WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON, 152, 16, 120, 30, window,
                                 reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdRenameMe)),
                                 instance, NULL);

    g_tally = CreateWindowExW(0, L"STATIC", L"L:0 R:0 D:0", WS_CHILD | WS_VISIBLE, 288, 22, 140,
                              20, window, reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdTally)),
                              instance, NULL);

    AddLabel(window, L"Message:", 16, 66);
    g_message = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
                                WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 112, 64, 200, 24, window,
                                reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdMessage)),
                                instance, NULL);

    AddLabel(window, L"Password:", 16, 106);
    CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
                    WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_PASSWORD, 112, 104, 200, 24,
                    window, reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdPassword)), instance,
                    NULL);

    CreateWindowExW(0, L"BUTTON", L"Disabled", WS_CHILD | WS_VISIBLE | WS_DISABLED | BS_PUSHBUTTON,
                    16, 146, 120, 30, window,
                    reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdDisabled)), instance, NULL);

    // A checkbox and a combo: the two controls whose state can be set AND read
    // back, which is what makes toggle/select provable rather than hopeful.
    CreateWindowExW(0, L"BUTTON", L"Enabled", WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX, 152, 146,
                    120, 30, window, reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdCheck)),
                    instance, NULL);

    // Its own label, so it does not inherit "Password:" from the static above by
    // z-order association.
    AddLabel(window, L"Choice:", 288, 128);
    HWND combo = CreateWindowExW(0, L"COMBOBOX", L"",
                                 WS_CHILD | WS_VISIBLE | WS_VSCROLL | CBS_DROPDOWNLIST, 288, 150,
                                 130, 200, window,
                                 reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdCombo)),
                                 instance, NULL);
    SendMessageW(combo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"Alpha"));
    SendMessageW(combo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"Beta"));
    SendMessageW(combo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"Gamma"));
    SendMessageW(combo, CB_SETCURSEL, 0, 0);

    AddLabel(window, L"Notes:", 16, 190);
    HWND notes = CreateWindowExW(
        WS_EX_CLIENTEDGE, L"EDIT", L"",
        WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE | ES_AUTOVSCROLL, 112, 188, 300, 140,
        window, reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdNotes)), instance, NULL);
    {
        // Enough lines that the view starts well above the bottom, so a scroll
        // has room to move and the read-back can see it move.
        std::wstring filler;
        for (int line = 1; line <= 80; ++line)
        {
            wchar_t entry[32];
            swprintf_s(entry, 32, L"line %d\r\n", line);
            filler += entry;
        }
        SetWindowTextW(notes, filler.c_str());
    }

    // SW_SHOWNOACTIVATE: appearing must not steal the operator's focus. The
    // message field is given focus explicitly so the background keyboard rungs
    // have a deterministic destination inside this window.
    ShowWindow(window, SW_SHOWNOACTIVATE);
    UpdateWindow(window);
    SetFocus(g_message);

    MSG message;
    while (GetMessageW(&message, NULL, 0, 0) > 0)
    {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return 0;
}

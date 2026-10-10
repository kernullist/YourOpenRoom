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
//   canvas      pane      -> a child window that draws itself, the way a browser
//                            or WPF window holds all its controls: with focus on
//                            it, the helper cannot see what has focus "inside".
//   "Terminal 1, bash" edit -> an editor's integrated terminal, inside a window
//                            that is not a terminal itself.
//   "Slow"      checkbox  -> applies each click 900 ms late, the way a slow app
//                            does, so a toggle cannot be read back in time.
//   "Alice"/"Bob" buttons -> share one control id, as list rows built from one
//                            template share an automation id.
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
const int kIdCanvas = 111;
const int kIdTerminalPane = 112;
const int kIdSlowCheck = 113;
const int kIdTwin = 114;
// One timer per request on the slow checkbox, so two requests really flip it
// twice -- the way an app that toggles on click behaves.
const UINT_PTR kSlowTimerBase = 1000;

WNDPROC g_buttonProc = NULL;
HWND g_renameMe = NULL;
HWND g_tally = NULL;
HWND g_message = NULL;
HWND g_canvas = NULL;
HWND g_terminalPane = NULL;
HWND g_slowCheck = NULL;
HWND g_twinA = NULL;
HWND g_twinB = NULL;
HWND g_console = NULL;
UINT_PTR g_slowClicks = 0;
WNDPROC g_slowProc = NULL;
bool g_applyingSlow = false;

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

// UI Automation sets a checkbox through BM_SETCHECK (or clicks it), and the
// state reads back at once. A slow app does not: this one turns every request
// into a flip of whatever the box shows 900 ms later, so a toggle cannot be read
// back inside the helper's wait -- and a second toggle sent on that stale read
// flips it straight back.
LRESULT CALLBACK SlowCheckProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    if ((message == BM_SETCHECK || message == BM_CLICK) && !g_applyingSlow)
    {
        g_slowClicks += 1;
        SetTimer(GetParent(hwnd), kSlowTimerBase + g_slowClicks, 900, NULL);
        return 0;
    }
    return CallWindowProcW(g_slowProc, hwnd, message, wParam, lParam);
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
    // Test hooks: move keyboard focus inside the fixture without raising it, so
    // the keyboard guards can be tested with focus on the password field.
    case WM_APP + 1:
    {
        SetFocus(GetDlgItem(hwnd, kIdPassword));
        break;
    }
    case WM_APP + 2:
    {
        SetFocus(g_message);
        break;
    }
    case WM_APP + 3:
    {
        SetFocus(g_canvas);
        break;
    }
    case WM_APP + 4:
    {
        SetFocus(g_terminalPane);
        break;
    }
    // Hand the foreground to the fixture's other window. Windows sometimes gives
    // a freshly started window the foreground, and a window in front has a
    // readable focus -- the background case has to be made, not hoped for.
    case WM_APP + 6:
    {
        if (g_console != NULL)
        {
            SetForegroundWindow(g_console);
        }
        break;
    }
    // The rows a list re-sorted or scrolled: same template, new names.
    case WM_APP + 5:
    {
        SetWindowTextW(g_twinA, L"Kim");
        SetWindowTextW(g_twinB, L"Lee");
        break;
    }
    case WM_TIMER:
    {
        if (wParam > kSlowTimerBase)
        {
            KillTimer(hwnd, wParam);
            const LRESULT state = SendMessageW(g_slowCheck, BM_GETCHECK, 0, 0);
            g_applyingSlow = true;
            SendMessageW(g_slowCheck, BM_SETCHECK, state == BST_CHECKED ? BST_UNCHECKED : BST_CHECKED,
                         0);
            g_applyingSlow = false;
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
                                  CW_USEDEFAULT, CW_USEDEFAULT, 460, 480, NULL, NULL, instance,
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

    // Created after everything above so their labels cannot re-associate with
    // the controls the earlier tests address.
    WNDCLASSEXW canvasClass = windowClass;
    canvasClass.lpfnWndProc = DefWindowProcW;
    canvasClass.lpszClassName = L"AoiTestCanvas";
    RegisterClassExW(&canvasClass);
    g_canvas = CreateWindowExW(WS_EX_CLIENTEDGE, L"AoiTestCanvas", L"",
                               WS_CHILD | WS_VISIBLE | WS_TABSTOP, 16, 340, 80, 24, window,
                               reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdCanvas)), instance,
                               NULL);

    CreateWindowExW(0, L"STATIC", L"Terminal 1, bash", WS_CHILD | WS_VISIBLE, 112, 342, 120, 20,
                    window, NULL, NULL, NULL);
    g_terminalPane = CreateWindowExW(
        WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 236, 340, 180, 24,
        window, reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdTerminalPane)), instance, NULL);

    // BS_CHECKBOX, not AUTOCHECKBOX: the app sets the check itself, late.
    g_slowCheck = CreateWindowExW(0, L"BUTTON", L"Slow", WS_CHILD | WS_VISIBLE | BS_CHECKBOX, 16,
                                  376, 80, 24, window,
                                  reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdSlowCheck)),
                                  instance, NULL);
    g_slowProc = reinterpret_cast<WNDPROC>(
        SetWindowLongPtrW(g_slowCheck, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(SlowCheckProc)));

    g_twinA = CreateWindowExW(0, L"BUTTON", L"Alice", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON, 112,
                              376, 70, 24, window,
                              reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdTwin)), instance,
                              NULL);
    g_twinB = CreateWindowExW(0, L"BUTTON", L"Bob", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON, 188,
                              376, 70, 24, window,
                              reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdTwin)), instance,
                              NULL);

    // A stand-in for a console window: same window class as conhost's, so the
    // helper's terminal guard can be tested without opening a real shell.
    WNDCLASSEXW consoleClass = windowClass;
    consoleClass.lpfnWndProc = DefWindowProcW;
    consoleClass.lpszClassName = L"ConsoleWindowClass";
    if (RegisterClassExW(&consoleClass) != 0)
    {
        const std::wstring consoleTitle = title + L" Console";
        HWND console = CreateWindowExW(0, L"ConsoleWindowClass", consoleTitle.c_str(),
                                       WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 240,
                                       160, NULL, NULL, instance, NULL);
        if (console != NULL)
        {
            ShowWindow(console, SW_SHOWNOACTIVATE);
            g_console = console;
        }
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

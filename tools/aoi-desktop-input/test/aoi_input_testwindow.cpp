// Test fixture window for aoi_desktop_input.exe.
//
// The input helper cannot be tested against the operator's real desktop: driving
// their live Chrome or Settings to prove a click landed is exactly the kind of
// side effect the helper exists to keep under control. So the tests get their
// own window, holding one control for each branch of the contract:
//
//   "Click Me"   button   -> the invoke path; its caption changes when clicked,
//                            which both proves the effect and retires the
//                            snapshot id (so the stale-ref refusal is testable)
//   "Message:"   edit     -> the set_value path with a real read-back
//   "Password:"  edit     -> ES_PASSWORD, must be REFUSED, never typed into
//   "Disabled"   button   -> WS_DISABLED, must be refused as a no-op
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

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

namespace
{

const int kIdClickMe = 101;
const int kIdMessage = 102;
const int kIdPassword = 103;
const int kIdDisabled = 104;

HWND g_clickMe = NULL;

LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    LRESULT result = 0;
    switch (message)
    {
    case WM_COMMAND:
    {
        if (LOWORD(wParam) == kIdClickMe && g_clickMe != NULL)
        {
            // Observable proof that the invoke landed, and a deliberate change
            // to the window's element identities so the previous snapshot id
            // stops being valid.
            SetWindowTextW(g_clickMe, L"Clicked!");
        }
        break;
    }
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
    CreateWindowExW(0, L"STATIC", text, WS_CHILD | WS_VISIBLE, x, y, 90, 20, parent, NULL,
                    NULL, NULL);
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
            while (!title.empty() && (title[title.size() - 1] == L'"' || title[title.size() - 1] == L' '))
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

    HWND window = CreateWindowExW(0, L"AoiInputTestFixture", title.c_str(),
                                  WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 360, 240,
                                  NULL, NULL, instance, NULL);
    if (window == NULL)
    {
        return 1;
    }

    g_clickMe = CreateWindowExW(0, L"BUTTON", L"Click Me", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                                16, 16, 120, 30, window,
                                reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdClickMe)),
                                instance, NULL);

    AddLabel(window, L"Message:", 16, 66);
    CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL, 112,
                    64, 200, 24, window,
                    reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdMessage)), instance, NULL);

    AddLabel(window, L"Password:", 16, 106);
    CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
                    WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL | ES_PASSWORD, 112, 104, 200, 24,
                    window, reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdPassword)), instance,
                    NULL);

    CreateWindowExW(0, L"BUTTON", L"Disabled",
                    WS_CHILD | WS_VISIBLE | WS_DISABLED | BS_PUSHBUTTON, 16, 146, 120, 30, window,
                    reinterpret_cast<HMENU>(static_cast<UINT_PTR>(kIdDisabled)), instance, NULL);

    ShowWindow(window, SW_SHOWNOACTIVATE);
    UpdateWindow(window);

    MSG message;
    while (GetMessageW(&message, NULL, 0, 0) > 0)
    {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return 0;
}

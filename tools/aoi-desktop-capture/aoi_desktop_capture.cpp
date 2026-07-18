// Aoi desktop-activity capture helper (host-bridge Phase 2, native capture).
//
// Purpose:
//   The Aoi daemon exposes POST /api/aoi-host/desktop-activity, but nothing
//   feeds it: the browser cannot see which native app the operator is actually
//   using. This helper is the missing producer. It watches the Windows
//   foreground window (event-driven, via SetWinEventHook) and POSTs a
//   metadata-only sample -- image name, focus, idle time, timestamp, and an
//   OPTIONAL window title -- to the loopback daemon, which normalizes, redacts,
//   consent-gates, and stores it as a taste signal.
//
// Why a separate native process (not the daemon, not the browser):
//   - Only a native process can observe the real desktop foreground.
//   - Crash isolation + privilege separation: a capture bug cannot take the
//     daemon down, and this process holds no secrets beyond the loopback token.
//   - Event-driven (EVENT_SYSTEM_FOREGROUND) instead of polling: it never misses
//     a short-lived foreground switch and costs effectively zero CPU at idle.
//
// Safety model (the daemon still enforces all of it; this is defense in depth):
//   - Metadata only. The sample carries an image BASENAME (never the full path),
//     focus flag, idle ms, and epoch ms. A window title is sent ONLY with
//     --capture-titles, and the daemon still drops/redacts it unless the operator
//     turned on the title sub-toggle for the desktop-activity source.
//   - The daemon requires: the file-permission auth token (proves same-user),
//     the desktop_activity kill-switch capability ON, and the desktop-activity
//     environment-source consent ON for the session. All default OFF -- this
//     helper posts into a closed door until the operator opens it.
//
// Transport: WinHTTP POST to http://127.0.0.1:7333 (loopback, no TLS). The token
// is read from <openroomHome>/host-bridge/auth-token and re-read on a 401 so a
// daemon-side token rotation self-heals.
//
// Build: build.ps1 (auto-locates MSVC). Install as a logon Scheduled Task with
// Install-AoiDesktopCapture.ps1. See README.md.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>
#include <string>
#include <cstdio>
#include <cstdarg>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "user32.lib")

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
struct CaptureConfig
{
    std::wstring openroomHome; // <home>/.openroom -- base of host-bridge/
    std::wstring sessionPath;  // consent scope, e.g. "aoi/default"
    std::wstring host;         // loopback host, default 127.0.0.1
    int port;                  // daemon port, default 7333
    unsigned int heartbeatMs;  // periodic resend of the current foreground; 0 = off
    bool captureTitles;        // include window titles (daemon still gates them)
    bool dryRun;               // print the JSON body instead of POSTing
    bool once;                 // capture one sample and exit (for verification)
    bool hideConsole;          // hide the console window at startup (resident mode)
    bool showHelp;
};

// One normalized foreground observation.
struct ForegroundSample
{
    bool valid;
    DWORD pid;
    std::string imageName; // utf-8 basename
    std::string title;     // utf-8, empty unless captureTitles
    DWORD idleMs;
    bool focused;
    unsigned long long observedAt; // epoch ms
};

// ---------------------------------------------------------------------------
// Process-wide state (single hook thread -> no synchronization needed)
// ---------------------------------------------------------------------------
static CaptureConfig g_cfg;
static std::wstring g_token;
static DWORD g_lastPid = 0;
static std::string g_lastKey;
static ULONGLONG g_lastSentTick = 0;
static const DWORD DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
static void LogLine(const char* fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    fprintf(stderr, "[aoi-desktop-capture] ");
    vfprintf(stderr, fmt, args);
    fprintf(stderr, "\n");
    fflush(stderr);
    va_end(args);
}

static std::string WideToUtf8(const std::wstring& value)
{
    if (value.empty())
    {
        return std::string();
    }
    int needed = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), (int)value.size(), NULL, 0, NULL, NULL);
    if (needed <= 0)
    {
        return std::string();
    }
    std::string out((size_t)needed, '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.c_str(), (int)value.size(), &out[0], needed, NULL, NULL);
    return out;
}

// Escape a UTF-8 string for embedding in a JSON string literal.
static std::string JsonEscape(const std::string& in)
{
    std::string out;
    out.reserve(in.size() + 8);
    for (size_t i = 0; i < in.size(); ++i)
    {
        unsigned char c = (unsigned char)in[i];
        if (c == '"')
        {
            out += "\\\"";
        }
        else if (c == '\\')
        {
            out += "\\\\";
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
            sprintf_s(buf, sizeof(buf), "\\u%04x", (unsigned int)c);
            out += buf;
        }
        else
        {
            out += (char)c;
        }
    }
    return out;
}

static unsigned long long EpochMillis()
{
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    ULARGE_INTEGER value;
    value.LowPart = ft.dwLowDateTime;
    value.HighPart = ft.dwHighDateTime;
    // FILETIME is 100ns ticks since 1601-01-01; shift to ms since 1970-01-01.
    const unsigned long long EPOCH_DIFF_100NS = 116444736000000000ULL;
    if (value.QuadPart < EPOCH_DIFF_100NS)
    {
        return 0;
    }
    return (value.QuadPart - EPOCH_DIFF_100NS) / 10000ULL;
}

// ---------------------------------------------------------------------------
// Home + token resolution
// ---------------------------------------------------------------------------
static std::wstring GetEnvW(const wchar_t* name)
{
    wchar_t buf[2048];
    DWORD n = GetEnvironmentVariableW(name, buf, (DWORD)(sizeof(buf) / sizeof(buf[0])));
    if (n == 0 || n >= (sizeof(buf) / sizeof(buf[0])))
    {
        return std::wstring();
    }
    return std::wstring(buf, n);
}

// Mirror the daemon's home resolution (aoiDaemonServer.ts): the host-bridge base
// is <sessionsDir>/.. and sessionsDir defaults to %USERPROFILE%/.openroom/sessions.
static std::wstring ResolveOpenroomHome(const std::wstring& explicitHome)
{
    if (!explicitHome.empty())
    {
        return explicitHome;
    }
    std::wstring sessions = GetEnvW(L"AOI_DAEMON_SESSIONS_DIR");
    if (!sessions.empty())
    {
        size_t slash = sessions.find_last_of(L"\\/");
        if (slash != std::wstring::npos)
        {
            return sessions.substr(0, slash);
        }
        return sessions;
    }
    std::wstring profile = GetEnvW(L"USERPROFILE");
    if (!profile.empty())
    {
        return profile + L"\\.openroom";
    }
    return L".openroom";
}

// Read <home>/host-bridge/auth-token and trim surrounding whitespace. The token
// is ASCII hex, so it widens byte-for-byte. Returns empty on any failure.
static std::wstring ReadAuthToken(const std::wstring& home)
{
    std::wstring path = home + L"\\host-bridge\\auth-token";
    HANDLE handle = CreateFileW(
        path.c_str(),
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        NULL,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        NULL);
    if (handle == INVALID_HANDLE_VALUE)
    {
        return std::wstring();
    }
    std::string raw;
    char buf[512];
    DWORD read = 0;
    while (ReadFile(handle, buf, sizeof(buf), &read, NULL) && read > 0)
    {
        raw.append(buf, read);
        if (raw.size() > 4096)
        {
            break;
        }
    }
    CloseHandle(handle);
    size_t start = 0;
    while (start < raw.size() && (unsigned char)raw[start] <= 0x20)
    {
        ++start;
    }
    size_t end = raw.size();
    while (end > start && (unsigned char)raw[end - 1] <= 0x20)
    {
        --end;
    }
    std::wstring token;
    token.reserve(end - start);
    for (size_t i = start; i < end; ++i)
    {
        token += (wchar_t)(unsigned char)raw[i];
    }
    return token;
}

// Read the token, retrying briefly so a cold start (helper up before the daemon
// mints the token) still finds it. waitSeconds == 0 means a single attempt.
static std::wstring ReadAuthTokenWithWait(const std::wstring& home, int waitSeconds)
{
    int attempts = waitSeconds > 0 ? waitSeconds : 1;
    for (int i = 0; i < attempts; ++i)
    {
        std::wstring token = ReadAuthToken(home);
        if (!token.empty())
        {
            return token;
        }
        if (i + 1 < attempts)
        {
            Sleep(1000);
        }
    }
    return std::wstring();
}

// ---------------------------------------------------------------------------
// Foreground capture + request building
// ---------------------------------------------------------------------------
static ForegroundSample CaptureForegroundSample(const CaptureConfig& cfg)
{
    ForegroundSample sample;
    sample.valid = false;
    sample.pid = 0;
    sample.idleMs = 0;
    sample.focused = false;
    sample.observedAt = 0;
    do
    {
        HWND hwnd = GetForegroundWindow();
        if (hwnd == NULL)
        {
            break;
        }
        DWORD pid = 0;
        GetWindowThreadProcessId(hwnd, &pid);
        if (pid == 0)
        {
            break;
        }
        std::wstring imagePath;
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (process != NULL)
        {
            wchar_t pathBuf[MAX_PATH];
            DWORD size = MAX_PATH;
            if (QueryFullProcessImageNameW(process, 0, pathBuf, &size))
            {
                imagePath.assign(pathBuf, size);
            }
            CloseHandle(process);
        }
        if (imagePath.empty())
        {
            // No image name -> the daemon would reject the sample; skip it.
            break;
        }
        size_t slash = imagePath.find_last_of(L"\\/");
        std::wstring baseName = (slash == std::wstring::npos) ? imagePath : imagePath.substr(slash + 1);
        sample.imageName = WideToUtf8(baseName);
        if (sample.imageName.empty())
        {
            break;
        }
        if (cfg.captureTitles)
        {
            int titleLen = GetWindowTextLengthW(hwnd);
            if (titleLen > 0)
            {
                std::wstring titleBuf;
                titleBuf.resize((size_t)titleLen + 1);
                int copied = GetWindowTextW(hwnd, &titleBuf[0], titleLen + 1);
                titleBuf.resize((size_t)(copied > 0 ? copied : 0));
                sample.title = WideToUtf8(titleBuf);
            }
        }
        LASTINPUTINFO lastInput;
        lastInput.cbSize = sizeof(lastInput);
        if (GetLastInputInfo(&lastInput))
        {
            sample.idleMs = (DWORD)(GetTickCount() - lastInput.dwTime);
        }
        sample.pid = pid;
        sample.focused = true;
        sample.observedAt = EpochMillis();
        sample.valid = true;
    }
    while (false);
    return sample;
}

static std::string BuildRequestBody(const CaptureConfig& cfg, const ForegroundSample& sample)
{
    std::string sessionUtf8 = WideToUtf8(cfg.sessionPath);
    char numBuf[32];
    std::string body;
    body += "{";
    body += "\"sessionPath\":\"" + JsonEscape(sessionUtf8) + "\",";
    body += "\"captureWindowTitles\":";
    body += cfg.captureTitles ? "true" : "false";
    body += ",\"sample\":{";
    body += "\"appName\":\"" + JsonEscape(sample.imageName) + "\",";
    body += "\"focused\":";
    body += sample.focused ? "true" : "false";
    sprintf_s(numBuf, sizeof(numBuf), "%lu", (unsigned long)sample.idleMs);
    body += ",\"idleMs\":";
    body += numBuf;
    sprintf_s(numBuf, sizeof(numBuf), "%llu", sample.observedAt);
    body += ",\"observedAt\":";
    body += numBuf;
    if (cfg.captureTitles && !sample.title.empty())
    {
        body += ",\"windowTitle\":\"" + JsonEscape(sample.title) + "\"";
    }
    body += "}}";
    return body;
}

// POST the body to the daemon. Returns true when a response status was read (in
// outStatus); false on any transport failure. Single-exit with handle cleanup.
static bool PostSample(const CaptureConfig& cfg, const std::wstring& token, const std::string& body, DWORD& outStatus)
{
    outStatus = 0;
    bool ok = false;
    HINTERNET session = NULL;
    HINTERNET connection = NULL;
    HINTERNET request = NULL;
    do
    {
        session = WinHttpOpen(
            L"AoiDesktopCapture/1.0",
            WINHTTP_ACCESS_TYPE_NO_PROXY,
            WINHTTP_NO_PROXY_NAME,
            WINHTTP_NO_PROXY_BYPASS,
            0);
        if (session == NULL)
        {
            break;
        }
        // Short timeouts: a hung daemon must not stall the hook thread.
        WinHttpSetTimeouts(session, 2000, 2000, 2000, 2000);
        connection = WinHttpConnect(session, cfg.host.c_str(), (INTERNET_PORT)cfg.port, 0);
        if (connection == NULL)
        {
            break;
        }
        request = WinHttpOpenRequest(
            connection,
            L"POST",
            L"/api/aoi-host/desktop-activity",
            NULL,
            WINHTTP_NO_REFERER,
            WINHTTP_DEFAULT_ACCEPT_TYPES,
            0);
        if (request == NULL)
        {
            break;
        }
        std::wstring headers = L"Content-Type: application/json\r\nx-aoi-host-bridge-token: ";
        headers += token;
        if (!WinHttpAddRequestHeaders(request, headers.c_str(), (DWORD)-1L, WINHTTP_ADDREQ_FLAG_ADD))
        {
            break;
        }
        BOOL sent = WinHttpSendRequest(
            request,
            WINHTTP_NO_ADDITIONAL_HEADERS,
            0,
            (LPVOID)body.data(),
            (DWORD)body.size(),
            (DWORD)body.size(),
            0);
        if (!sent)
        {
            break;
        }
        if (!WinHttpReceiveResponse(request, NULL))
        {
            break;
        }
        DWORD statusCode = 0;
        DWORD statusLen = sizeof(statusCode);
        if (WinHttpQueryHeaders(
                request,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                WINHTTP_HEADER_NAME_BY_INDEX,
                &statusCode,
                &statusLen,
                WINHTTP_NO_HEADER_INDEX))
        {
            outStatus = statusCode;
            ok = true;
        }
    }
    while (false);
    if (request != NULL)
    {
        WinHttpCloseHandle(request);
    }
    if (connection != NULL)
    {
        WinHttpCloseHandle(connection);
    }
    if (session != NULL)
    {
        WinHttpCloseHandle(session);
    }
    return ok;
}

// Capture the current foreground and deliver it. `force` (heartbeat / startup)
// bypasses the debounce that collapses identical rapid foreground bursts.
static void SendForeground(bool force)
{
    ForegroundSample sample = CaptureForegroundSample(g_cfg);
    if (!sample.valid)
    {
        return;
    }
    std::string key = sample.imageName;
    key += '\x1f';
    key += sample.title;
    ULONGLONG nowTick = GetTickCount64();
    if (!force && sample.pid == g_lastPid && key == g_lastKey && (nowTick - g_lastSentTick) < DEBOUNCE_MS)
    {
        return;
    }
    std::string body = BuildRequestBody(g_cfg, sample);
    if (g_cfg.dryRun)
    {
        fprintf(stdout, "%s\n", body.c_str());
        fflush(stdout);
        g_lastPid = sample.pid;
        g_lastKey = key;
        g_lastSentTick = nowTick;
        return;
    }
    if (g_token.empty())
    {
        g_token = ReadAuthToken(g_cfg.openroomHome);
    }
    DWORD status = 0;
    bool ok = PostSample(g_cfg, g_token, body, status);
    if (ok && status == 401)
    {
        // Token rotated on the daemon side; reload and retry exactly once.
        g_token = ReadAuthToken(g_cfg.openroomHome);
        ok = PostSample(g_cfg, g_token, body, status);
    }
    if (ok && status == 200)
    {
        g_lastPid = sample.pid;
        g_lastKey = key;
        g_lastSentTick = nowTick;
    }
    else if (ok)
    {
        LogLine("daemon rejected sample (status=%lu app=%s)", (unsigned long)status, sample.imageName.c_str());
    }
    else
    {
        LogLine("post failed (daemon unreachable?)");
    }
}

// ---------------------------------------------------------------------------
// Hook + timer callbacks
// ---------------------------------------------------------------------------
static void CALLBACK WinEventProc(
    HWINEVENTHOOK /*hook*/,
    DWORD event,
    HWND /*hwnd*/,
    LONG idObject,
    LONG idChild,
    DWORD /*eventThread*/,
    DWORD /*eventTime*/)
{
    if (event == EVENT_SYSTEM_FOREGROUND && idObject == OBJID_WINDOW && idChild == CHILDID_SELF)
    {
        SendForeground(false);
    }
}

static void CALLBACK HeartbeatTimerProc(HWND /*hwnd*/, UINT /*message*/, UINT_PTR /*timerId*/, DWORD /*tick*/)
{
    SendForeground(true);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
static void PrintUsage()
{
    fprintf(stdout,
        "aoi_desktop_capture -- feed foreground activity to the Aoi daemon.\n"
        "\n"
        "Options:\n"
        "  --home <path>          host-bridge base (default: %%USERPROFILE%%\\.openroom)\n"
        "  --session <path>       consent scope (default: aoi/default)\n"
        "  --host <host>          daemon host (default: 127.0.0.1)\n"
        "  --port <n>             daemon port (default: 7333)\n"
        "  --heartbeat-ms <n>     periodic resend of current foreground (default: 30000; 0 = off)\n"
        "  --capture-titles       include window titles (daemon still gates/redacts)\n"
        "  --dry-run              print the JSON body instead of POSTing\n"
        "  --once                 capture a single sample and exit\n"
        "  --hide-console         hide the console window at startup (resident mode)\n"
        "  --help                 show this help\n");
}

static bool ParseArgs(int argc, wchar_t** argv, CaptureConfig& cfg)
{
    cfg.sessionPath = L"aoi/default";
    cfg.host = L"127.0.0.1";
    cfg.port = 7333;
    cfg.heartbeatMs = 30000;
    cfg.captureTitles = false;
    cfg.dryRun = false;
    cfg.once = false;
    cfg.hideConsole = false;
    cfg.showHelp = false;
    std::wstring explicitHome;
    for (int i = 1; i < argc; ++i)
    {
        std::wstring arg = argv[i];
        if (arg == L"--help" || arg == L"-h" || arg == L"/?")
        {
            cfg.showHelp = true;
        }
        else if (arg == L"--capture-titles")
        {
            cfg.captureTitles = true;
        }
        else if (arg == L"--dry-run")
        {
            cfg.dryRun = true;
        }
        else if (arg == L"--once")
        {
            cfg.once = true;
        }
        else if (arg == L"--hide-console")
        {
            cfg.hideConsole = true;
        }
        else if (arg == L"--home" && i + 1 < argc)
        {
            explicitHome = argv[++i];
        }
        else if (arg == L"--session" && i + 1 < argc)
        {
            cfg.sessionPath = argv[++i];
        }
        else if (arg == L"--host" && i + 1 < argc)
        {
            cfg.host = argv[++i];
        }
        else if (arg == L"--port" && i + 1 < argc)
        {
            cfg.port = _wtoi(argv[++i]);
        }
        else if (arg == L"--heartbeat-ms" && i + 1 < argc)
        {
            cfg.heartbeatMs = (unsigned int)_wtoi(argv[++i]);
        }
        else
        {
            LogLine("unknown or incomplete argument");
            return false;
        }
    }
    if (cfg.port <= 0 || cfg.port > 65535)
    {
        LogLine("invalid --port");
        return false;
    }
    cfg.openroomHome = ResolveOpenroomHome(explicitHome);
    return true;
}

int wmain(int argc, wchar_t** argv)
{
    if (!ParseArgs(argc, argv, g_cfg))
    {
        PrintUsage();
        return 2;
    }
    if (g_cfg.showHelp)
    {
        PrintUsage();
        return 0;
    }
    if (g_cfg.hideConsole)
    {
        HWND console = GetConsoleWindow();
        if (console != NULL)
        {
            ShowWindow(console, SW_HIDE);
        }
    }
    if (!g_cfg.dryRun)
    {
        g_token = ReadAuthTokenWithWait(g_cfg.openroomHome, g_cfg.once ? 0 : 15);
        if (g_token.empty())
        {
            std::string homeUtf8 = WideToUtf8(g_cfg.openroomHome);
            LogLine("no auth token under %s\\host-bridge yet; will retry on each send", homeUtf8.c_str());
        }
    }
    if (g_cfg.once)
    {
        SendForeground(true);
        return 0;
    }
    HWINEVENTHOOK hook = SetWinEventHook(
        EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_FOREGROUND,
        NULL,
        WinEventProc,
        0,
        0,
        WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    if (hook == NULL)
    {
        LogLine("SetWinEventHook failed");
        return 1;
    }
    UINT_PTR heartbeat = 0;
    if (g_cfg.heartbeatMs > 0)
    {
        heartbeat = SetTimer(NULL, 0, g_cfg.heartbeatMs, HeartbeatTimerProc);
    }
    // Send an initial sample so we do not wait for the first foreground switch.
    SendForeground(true);
    {
        std::string hostUtf8 = WideToUtf8(g_cfg.host);
        std::string sessionUtf8 = WideToUtf8(g_cfg.sessionPath);
        LogLine(
            "capturing foreground -> http://%s:%d (session=%s titles=%s)",
            hostUtf8.c_str(),
            g_cfg.port,
            sessionUtf8.c_str(),
            g_cfg.captureTitles ? "on" : "off");
    }
    MSG msg;
    BOOL got = 0;
    while ((got = GetMessageW(&msg, NULL, 0, 0)) > 0)
    {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    if (heartbeat != 0)
    {
        KillTimer(NULL, heartbeat);
    }
    UnhookWinEvent(hook);
    return 0;
}

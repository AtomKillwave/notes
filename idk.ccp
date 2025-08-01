#define _WIN32_WINNT 0x0600
#include <windows.h>
#include <uxtheme.h>
#include <commdlg.h>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <cctype>
#include <algorithm>
#include <unordered_map>
#include  <mutex>
#pragma comment(lib, "UxTheme.lib")
#pragma comment(lib, "Comdlg32.lib")

// Control IDs
#define ID_STATIC_TITLE    101
#define ID_STATIC_PLUS     102
#define ID_STATIC_VERSION  103
#define ID_BUTTON_IMPORT   201
#define ID_BUTTON_EXPORT   202
#define ID_BUTTON_START    203
#define ID_BUTTON_STOP     204
#define ID_EDIT_BOX        301

// Переменная версии
const wchar_t* APP_VERSION = L"V1.1";
const wchar_t* INITIAL_TEXT = L"# Welcome to the Macros Plus!\r\n"
L"message(\"Hello Macros!\")";

// Глобальные ресурсы GUI
HBRUSH hBackgroundBrush = nullptr;
HBRUSH hControlBrush = nullptr;
HFONT  hTitleFont = nullptr;
HFONT  hVersionFont = nullptr;
int    g_titleHeight = 0;

// Статусы макроса
static bool s_bRunning = false;
static bool s_bStopRequested = false;
static HANDLE s_hThread = nullptr;
static HWND g_hMainWnd = nullptr;

// Глобальные структуры для функций и привязок
static std::unordered_map<std::wstring, std::vector<struct MacroCommand>> g_functions;
static std::vector<std::pair<UINT, std::wstring>> g_eventHandlers; // (vk, function_name)
static std::unordered_map<UINT, std::wstring> g_unbindHandlers;
static std::unordered_map<std::wstring, std::atomic<bool>> g_functionStopFlags;
static std::unordered_map<std::wstring, std::vector<UINT>> g_functionPressedKeys;
static std::unordered_map<std::wstring, HANDLE> g_runningFunctionThreads;
static std::unordered_map<std::wstring, std::atomic<bool>> g_functionRunning;
static std::mutex g_threadMutex;

// Пользовательские сообщения
#define WM_MACRO_FINISHED (WM_USER + 1)
#define WM_MACRO_ERROR    (WM_USER + 2)

// Типы команд макроса
enum class CommandType { Press, Release, Wait, Connect, Disconnect, Message };

struct MacroCommand {
    CommandType type;
    UINT vk;               // для Press/Release
    DWORD time;            // для Wait
    std::wstring funcName; // для Call
    std::wstring message;  // для Message
};

// Прототипы
HWND CreateThemedButton(HWND parent, int id, const wchar_t* text, int x, int y, int w, int h);
UINT StringToVK(const std::wstring& key);
bool IsExtendedKey(UINT vk);
void SendInputEvent(UINT vk, bool bKeyDown);
DWORD WINAPI MacroThread(LPVOID lpParam);
DWORD WINAPI EventThreadProc(LPVOID lpParam);
DWORD WINAPI FunctionThreadProc(LPVOID lpParam);
void ExportMacro(HWND hwnd);
void ImportMacro(HWND hwnd);
LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);
int RunGui(HINSTANCE hInstance, int nCmdShow);

// Утилиты для работы со строками
static std::wstring Trim(const std::wstring& s) {
    size_t start = s.find_first_not_of(L" \t\r\n");
    if (start == std::wstring::npos) return L"";
    size_t end = s.find_last_not_of(L" \t\r\n");
    std::wstring res = s.substr(start, end - start + 1);
    if (!res.empty() && res[0] == 0xFEFF) {
        res.erase(0, 1);
    }
    return res;
}

// Утилиты конвертации UTF-8 <-> wstring
static bool WStringToUTF8(const std::wstring& wstr, std::string& outUtf8) {
    if (wstr.empty()) {
        outUtf8.clear();
        return true;
    }
    int required = WideCharToMultiByte(
        CP_UTF8, 0,
        wstr.data(), (int)wstr.size(),
        nullptr, 0,
        nullptr, nullptr);
    if (required <= 0) return false;
    outUtf8.resize(required);
    int written = WideCharToMultiByte(
        CP_UTF8, 0,
        wstr.data(), (int)wstr.size(),
        &outUtf8[0], required,
        nullptr, nullptr);
    return written == required;
}
static bool UTF8ToWString(const std::string& utf8, std::wstring& outWstr) {
    if (utf8.empty()) {
        outWstr.clear();
        return true;
    }
    int required = MultiByteToWideChar(
        CP_UTF8, 0,
        utf8.data(), (int)utf8.size(),
        nullptr, 0);
    if (required <= 0) return false;
    outWstr.resize(required);
    int written = MultiByteToWideChar(
        CP_UTF8, 0,
        utf8.data(), (int)utf8.size(),
        &outWstr[0], required);
    return written == required;
}

// Создание темизированных кнопок с корректным приведением ID
HWND CreateThemedButton(HWND parent, int id, const wchar_t* text, int x, int y, int w, int h) {
    HWND hBtn = CreateWindowEx(
        0,
        L"BUTTON",
        text,
        WS_CHILD | WS_VISIBLE | BS_OWNERDRAW,
        x, y, w, h,
        parent,
        reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
        GetModuleHandle(nullptr),
        nullptr
    );
    if (hBtn) {
        SetWindowTheme(hBtn, L"", L"");
    }
    return hBtn;
}

// Проверка, является ли виртуальный код расширенной клавишей
bool IsExtendedKey(UINT vk) {
    switch (vk) {
    case VK_RMENU: case VK_RCONTROL:
    case VK_INSERT: case VK_DELETE:
    case VK_HOME: case VK_END:
    case VK_PRIOR: case VK_NEXT: // PageUp/PageDown
    case VK_UP: case VK_DOWN: case VK_LEFT: case VK_RIGHT:
    case VK_NUMLOCK:
    case VK_DIVIDE:
    case VK_RWIN:
        return true;
    default:
        return false;
    }
}

// Расширенный StringToVK: поддерживает буквы, цифры, функциональные, навигационные, модификаторы, numpad, пунктуацию US и мышь
UINT StringToVK(const std::wstring& key) {
    if (key.empty()) return 0;
    static std::unordered_map<std::wstring, UINT> vkMap;
    static bool initialized = false;
    if (!initialized) {
        initialized = true;
        auto& m = vkMap;
        // Специальные
        m[L"SPACE"] = VK_SPACE;
        m[L"ENTER"] = VK_RETURN;
        m[L"RETURN"] = VK_RETURN;
        m[L"ESC"] = VK_ESCAPE;
        m[L"ESCAPE"] = VK_ESCAPE;
        m[L"TAB"] = VK_TAB;
        m[L"CAPSLOCK"] = VK_CAPITAL;
        m[L"CAPITAL"] = VK_CAPITAL;
        m[L"SHIFT"] = VK_SHIFT;
        m[L"LSHIFT"] = VK_LSHIFT;
        m[L"RSHIFT"] = VK_RSHIFT;
        m[L"CTRL"] = VK_CONTROL;
        m[L"CONTROL"] = VK_CONTROL;
        m[L"LCTRL"] = VK_LCONTROL;
        m[L"RCTRL"] = VK_RCONTROL;
        m[L"ALT"] = VK_MENU;
        m[L"MENU"] = VK_MENU;
        m[L"LALT"] = VK_LMENU;
        m[L"RALT"] = VK_RMENU;
        m[L"WIN"] = VK_LWIN;
        m[L"LWIN"] = VK_LWIN;
        m[L"RWIN"] = VK_RWIN;
        m[L"BACKSPACE"] = VK_BACK;
        m[L"BACK"] = VK_BACK;
        m[L"DELETE"] = VK_DELETE;
        m[L"DEL"] = VK_DELETE;
        m[L"INSERT"] = VK_INSERT;
        m[L"INS"] = VK_INSERT;
        m[L"HOME"] = VK_HOME;
        m[L"END"] = VK_END;
        m[L"PAGEUP"] = VK_PRIOR;
        m[L"PAGEDOWN"] = VK_NEXT;
        m[L"PRIOR"] = VK_PRIOR;
        m[L"NEXT"] = VK_NEXT;
        m[L"UP"] = VK_UP;
        m[L"DOWN"] = VK_DOWN;
        m[L"LEFT"] = VK_LEFT;
        m[L"RIGHT"] = VK_RIGHT;
        m[L"PRINTSCREEN"] = VK_SNAPSHOT;
        m[L"PRTSC"] = VK_SNAPSHOT;
        m[L"SCROLLLOCK"] = VK_SCROLL;
        m[L"SCROLL"] = VK_SCROLL;
        m[L"PAUSE"] = VK_PAUSE;
        m[L"BREAK"] = VK_PAUSE;
        m[L"NUMLOCK"] = VK_NUMLOCK;
        m[L"SNAPSHOT"] = VK_SNAPSHOT;

        // Кнопки мыши
        m[L"LMB"] = VK_LBUTTON;
        m[L"RMB"] = VK_RBUTTON;
        m[L"MMB"] = VK_MBUTTON;
        m[L"MBUTTON"] = VK_MBUTTON;
        m[L"X1"] = VK_XBUTTON1;
        m[L"X2"] = VK_XBUTTON2;
        m[L"XBUTTON1"] = VK_XBUTTON1;
        m[L"XBUTTON2"] = VK_XBUTTON2;

        // Функциональные F1..F24
        for (int i = 1; i <= 24; i++) {
            wchar_t buf[8];
            swprintf_s(buf, L"F%d", i);
            m[buf] = VK_F1 + (i - 1);
        }
        // Numpad 0-9, NumPad*, +, -, ., /
        m[L"NUMPAD0"] = VK_NUMPAD0;
        m[L"NUMPAD1"] = VK_NUMPAD1;
        m[L"NUMPAD2"] = VK_NUMPAD2;
        m[L"NUMPAD3"] = VK_NUMPAD3;
        m[L"NUMPAD4"] = VK_NUMPAD4;
        m[L"NUMPAD5"] = VK_NUMPAD5;
        m[L"NUMPAD6"] = VK_NUMPAD6;
        m[L"NUMPAD7"] = VK_NUMPAD7;
        m[L"NUMPAD8"] = VK_NUMPAD8;
        m[L"NUMPAD9"] = VK_NUMPAD9;
        m[L"NUM0"] = VK_NUMPAD0;
        m[L"NUM1"] = VK_NUMPAD1;
        m[L"NUM2"] = VK_NUMPAD2;
        m[L"NUM3"] = VK_NUMPAD3;
        m[L"NUM4"] = VK_NUMPAD4;
        m[L"NUM5"] = VK_NUMPAD5;
        m[L"NUM6"] = VK_NUMPAD6;
        m[L"NUM7"] = VK_NUMPAD7;
        m[L"NUM8"] = VK_NUMPAD8;
        m[L"NUM9"] = VK_NUMPAD9;
        m[L"NUMPADMULTIPLY"] = VK_MULTIPLY;
        m[L"NUMMULT"] = VK_MULTIPLY;
        m[L"NUMPADADD"] = VK_ADD;
        m[L"NUMADD"] = VK_ADD;
        m[L"NUMPADMINUS"] = VK_SUBTRACT;
        m[L"NUMSUB"] = VK_SUBTRACT;
        m[L"NUMPADDOT"] = VK_DECIMAL;
        m[L"NUMDOT"] = VK_DECIMAL;
        m[L"NUMPADDIVIDE"] = VK_DIVIDE;
        m[L"NUMDIV"] = VK_DIVIDE;
        // Мультимедиа
        m[L"VOLUME_MUTE"] = VK_VOLUME_MUTE;
        m[L"VOLUME_UP"] = VK_VOLUME_UP;
        m[L"VOLUME_DOWN"] = VK_VOLUME_DOWN;
        m[L"MEDIA_NEXT_TRACK"] = VK_MEDIA_NEXT_TRACK;
        m[L"MEDIA_PREV_TRACK"] = VK_MEDIA_PREV_TRACK;
        m[L"MEDIA_PLAY_PAUSE"] = VK_MEDIA_PLAY_PAUSE;
        m[L"MEDIA_STOP"] = VK_MEDIA_STOP;
        m[L"LAUNCH_MAIL"] = VK_LAUNCH_MAIL;
        m[L"LAUNCH_MEDIA_SELECT"] = VK_LAUNCH_MEDIA_SELECT;
        m[L"LAUNCH_APP1"] = VK_LAUNCH_APP1;
        m[L"LAUNCH_APP2"] = VK_LAUNCH_APP2;
        // OEM
        m[L"OEM_1"] = VK_OEM_1;
        m[L"OEM_PLUS"] = VK_OEM_PLUS;
        m[L"OEM_COMMA"] = VK_OEM_COMMA;
        m[L"OEM_MINUS"] = VK_OEM_MINUS;
        m[L"OEM_PERIOD"] = VK_OEM_PERIOD;
        m[L"OEM_2"] = VK_OEM_2;
        m[L"OEM_3"] = VK_OEM_3;
        m[L"OEM_4"] = VK_OEM_4;
        m[L"OEM_5"] = VK_OEM_5;
        m[L"OEM_6"] = VK_OEM_6;
        m[L"OEM_7"] = VK_OEM_7;
        // Системные
        m[L"APPLICATION"] = VK_APPS;
        m[L"APP"] = VK_APPS;
        m[L"HELP"] = VK_HELP;
        m[L"BROWSER_BACK"] = VK_BROWSER_BACK;
        m[L"BROWSER_FORWARD"] = VK_BROWSER_FORWARD;
        // и т.д.
    }
    // Приводим к верхнему регистру ASCII и убираем пробелы/табы
    std::wstring up = key;
    for (auto& ch : up) {
        if (ch >= L'a' && ch <= L'z') ch = towupper(ch);
        // прочие символы остаются
    }
    up.erase(std::remove_if(up.begin(), up.end(), [](wchar_t c) { return c == L' ' || c == L'\t'; }), up.end());
    auto it = vkMap.find(up);
    if (it != vkMap.end()) {
        return it->second;
    }
    // Если одиночный символ: буква или цифра или пунктуация
    if (key.length() == 1) {
        wchar_t ch = key[0];
        if (ch >= L'a' && ch <= L'z') ch = towupper(ch);
        if ((ch >= L'A' && ch <= L'Z') || (ch >= L'0' && ch <= L'9')) {
            return static_cast<UINT>(ch);
        }
        switch (ch) {
        case L';': case L':': return VK_OEM_1;
        case L'=': case L'+': return VK_OEM_PLUS;
        case L',': case L'<': return VK_OEM_COMMA;
        case L'-': case L'_': return VK_OEM_MINUS;
        case L'.': case L'>': return VK_OEM_PERIOD;
        case L'/': case L'?': return VK_OEM_2;
        case L'`': case L'~': return VK_OEM_3;
        case L'[': case L'{': return VK_OEM_4;
        case L'\\': case L'|': return VK_OEM_5;
        case L']': case L'}': return VK_OEM_6;
        case L'\'': case L'"': return VK_OEM_7;
        default:
            break;
        }
    }
    return 0;
}

// Инъекция нажатия/отпускания клавиши или кнопки мыши через SendInput
void SendInputEvent(UINT vk, bool bKeyDown) {
    if (vk == 0) return;

    INPUT input = {};
    input.type = INPUT_KEYBOARD;

    // Проверяем, является ли vk кодом клавиатуры или мыши
    if (vk >= VK_LBUTTON && vk <= VK_XBUTTON2) {
        input.type = INPUT_MOUSE;
        input.mi.dwFlags = 0;
        input.mi.time = 0;
        input.mi.dwExtraInfo = 0;

        switch (vk) {
        case VK_LBUTTON:
            input.mi.dwFlags = bKeyDown ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
            break;
        case VK_RBUTTON:
            input.mi.dwFlags = bKeyDown ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
            break;
        case VK_MBUTTON:
            input.mi.dwFlags = bKeyDown ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
            break;
        case VK_XBUTTON1:
        case VK_XBUTTON2:
            input.mi.dwFlags = bKeyDown ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP;
            input.mi.mouseData = (vk == VK_XBUTTON1) ? XBUTTON1 : XBUTTON2;
            break;
        }
    }
    else {
        // Клавиатурное событие
        WORD scan = static_cast<WORD>(MapVirtualKey(vk, MAPVK_VK_TO_VSC));
        input.ki.wVk = 0;
        input.ki.wScan = scan;
        input.ki.dwFlags = KEYEVENTF_SCANCODE | (bKeyDown ? 0 : KEYEVENTF_KEYUP);
        if (IsExtendedKey(vk)) {
            input.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
        }
        input.ki.time = 0;
        input.ki.dwExtraInfo = 0;
    }

    SendInput(1, &input, sizeof(INPUT));
}

// Рекурсивный парсер с поддержкой основных команд
bool ParseCommandsRecursive(
    const std::vector<std::wstring>& lines,
    size_t startIdx,
    size_t endIdx,
    std::vector<MacroCommand>& outCommands,
    wchar_t** errorMsg,
    int& errorLine
) {
    size_t i = startIdx;
    while (i < endIdx) {
        std::wstring raw = Trim(lines[i]);
        int lineNum = static_cast<int>(i + 1);
        if (raw.empty() || raw[0] == L'#') {
            i++;
            continue;
        }
        // loop(count) { ... }
        std::wstring rawLower = raw;
        for (size_t k = 0; k + 3 < rawLower.size(); k++) {
            if (rawLower[k] >= L'A' && rawLower[k] <= L'Z') rawLower[k] = towlower(rawLower[k]);
        }
        if (rawLower.size() >= 4 && rawLower.substr(0, 4) == L"loop") {
            size_t parenStart = raw.find(L'(');
            size_t parenEnd = raw.find(L')');
            if (parenStart == std::wstring::npos || parenEnd == std::wstring::npos || parenEnd <= parenStart + 1) {
                *errorMsg = new wchar_t[256];
                wsprintf(*errorMsg, L"Syntax error in loop() (stroke: %d)", lineNum);
                errorLine = lineNum;
                return false;
            }
            std::wstring numStr = Trim(raw.substr(parenStart + 1, parenEnd - parenStart - 1));
            DWORD repeatCount = 0;
            try {
                repeatCount = std::stoul(numStr);
            }
            catch (...) {
                *errorMsg = new wchar_t[256];
                wsprintf(*errorMsg, L"Incorrect number in the loop (stroke: %d)", lineNum);
                errorLine = lineNum;
                return false;
            }
            size_t afterParen = parenEnd + 1;
            while (afterParen < raw.size() && (raw[afterParen] == L' ' || raw[afterParen] == L'\t')) afterParen++;
            if (afterParen >= raw.size() || raw[afterParen] != L'{') {
                *errorMsg = new wchar_t[256];
                wsprintf(*errorMsg, L"Expected '{' after loop(...) (stoke: %d)", lineNum);
                errorLine = lineNum;
                return false;
            }
            size_t nested = 1;
            size_t j = i + 1;
            for (; j < endIdx; j++) {
                std::wstring t = Trim(lines[j]);
                std::wstring tLower = t;
                for (size_t k = 0; k + 3 < tLower.size(); k++) {
                    if (tLower[k] >= L'A' && tLower[k] <= L'Z') tLower[k] = towlower(tLower[k]);
                }
                if (tLower.size() >= 4 && tLower.substr(0, 4) == L"loop") {
                    size_t ps = t.find(L'(');
                    size_t pe = t.find(L')');
                    if (ps != std::wstring::npos && pe != std::wstring::npos && pe + 1 < t.size()) {
                        size_t ap = pe + 1;
                        while (ap < t.size() && (t[ap] == L' ' || t[ap] == L'\t')) ap++;
                        if (ap < t.size() && t[ap] == L'{') {
                            nested++;
                            continue;
                        }
                    }
                }
                if (!t.empty() && t[0] == L'}') {
                    nested--;
                    if (nested == 0) break;
                }
            }
            if (j >= endIdx) {
                *errorMsg = new wchar_t[256];
                wsprintf(*errorMsg, L"'}' Not found for loop, (stroke: %d)", lineNum);
                errorLine = lineNum;
                return false;
            }
            size_t blockStart = i + 1;
            size_t blockEnd = j;
            std::vector<MacroCommand> innerCommands;
            if (!ParseCommandsRecursive(lines, blockStart, blockEnd, innerCommands, errorMsg, errorLine)) {
                return false;
            }
            for (DWORD r = 0; r < repeatCount; r++) {
                for (const auto& cmd : innerCommands) {
                    outCommands.push_back(cmd);
                }
            }
            i = j + 1;
            continue;
        }

        // Обычная команда: press/release/wait/call
        size_t parenStart = raw.find(L'(');
        size_t parenEnd = raw.find(L')');
        if (parenStart == std::wstring::npos || parenEnd == std::wstring::npos || parenEnd <= parenStart + 1) {
            *errorMsg = new wchar_t[256];
            wsprintf(*errorMsg, L"Command syntax error (stroke: %d)", lineNum);
            errorLine = lineNum;
            return false;
        }
        std::wstring cmdName = Trim(raw.substr(0, parenStart));
        std::wstring arg = Trim(raw.substr(parenStart + 1, parenEnd - parenStart - 1));
        std::wstring cmdLower = cmdName;
        for (auto& ch : cmdLower) {
            if (ch >= L'A' && ch <= L'Z') ch = towlower(ch);
        }
        if (cmdLower == L"press" || cmdLower == L"release") {
            if (arg.size() < 2 || arg.front() != L'"' || arg.back() != L'"') {
                *errorMsg = new wchar_t[256];
                wsprintf(*errorMsg, L"Expected string in quotes (stroke: %d)", lineNum);
                errorLine = lineNum;
                return false;
            }
            std::wstring key = arg.substr(1, arg.size() - 2);
            UINT vk = StringToVK(key);
            if (vk == 0) {
                *errorMsg = new wchar_t[256];
                wsprintf(*errorMsg, L"Unknown key: '%s' (stroke: %d)", key.c_str(), lineNum);
                errorLine = lineNum;
                return false;
            }
            MacroCommand mc;
            mc.type = (cmdLower == L"press") ? CommandType::Press : CommandType::Release;
            mc.vk = vk;
            mc.time = 0;
            mc.funcName = L"";
            outCommands.push_back(mc);
        }
        else if (cmdLower == L"wait") {
            try {
                DWORD t = std::stoul(arg);
                MacroCommand mc;
                mc.type = CommandType::Wait;
                mc.time = t;
                mc.vk = 0;
                mc.funcName = L"";
                outCommands.push_back(mc);
            }
            catch (...) {
                *errorMsg = new wchar_t[256];
                wsprintf(*errorMsg, L"Incorrect waiting time (stroke: %d)", lineNum);
                errorLine = lineNum;
                return false;
            }
        }
        else if (cmdLower == L"connect") {
            // Запуск функции асинхронно
            if (arg.size() < 2 || arg.front() != L'"' || arg.back() != L'"') {
                *errorMsg = new wchar_t[256];
                wsprintf(*errorMsg, L"Expected quoted string for connect (строка: %d)", lineNum);
                errorLine = lineNum;
                return false;
            }
            std::wstring funcName = arg.substr(1, arg.size() - 2);
            MacroCommand mc;
            mc.type = CommandType::Connect;
            mc.funcName = funcName;
            mc.vk = 0;
            mc.time = 0;
            outCommands.push_back(mc);
        }
        else if (cmdLower == L"disconnect") {
            // Остановка ранее запущенной функции
            if (arg.size() < 2 || arg.front() != L'"' || arg.back() != L'"') {
                *errorMsg = new wchar_t[256];
                wsprintf(*errorMsg, L"Expected quoted string for disconnect (строка: %d)", lineNum);
                errorLine = lineNum;
                return false;
            }
            std::wstring funcName = arg.substr(1, arg.size() - 2);
            MacroCommand mc;
            mc.type = CommandType::Disconnect;
            mc.funcName = funcName;
            mc.vk = 0;
            mc.time = 0;
            outCommands.push_back(mc);
        }
        else if (cmdLower == L"message") {
            // кавычки обязательны
            if (arg.size() < 2 || arg.front() != L'"' || arg.back() != L'"') {
                *errorMsg = new wchar_t[256];
                wsprintf(*errorMsg, L"Expected quoted string for message (stroke: %d)", lineNum);
                errorLine = lineNum;
                return false;
            }
            std::wstring text = arg.substr(1, arg.size() - 2);

            MacroCommand mc;
            mc.type = CommandType::Message;
            mc.message = text;
            mc.vk = 0;
            mc.time = 0;
            outCommands.push_back(mc);
        }
        else {
            *errorMsg = new wchar_t[256];
            wsprintf(*errorMsg, L"Unknown command: '%s' (stroke: %d)", cmdName.c_str(), lineNum);
            errorLine = lineNum;
            return false;
        }
        i++;
    }
    return true;
}

// Поток для отслеживания нажатий клавиш и вызова функций
// Поток для отслеживания нажатий и отпусканий клавиш и вызова функций
DWORD WINAPI EventThreadProc(LPVOID lpParam) {
    UNREFERENCED_PARAMETER(lpParam);
    // Map ключевых кодов в предыдущее состояние (зажата/отпущена)
    std::unordered_map<UINT, bool> prevState;
    for (auto& eh : g_eventHandlers) {
        prevState[eh.first] = false;
    }
    // Аналогично для unbind
    std::unordered_map<UINT, bool> prevStateUnbind;
    for (auto& uh : g_unbindHandlers) {
        prevStateUnbind[uh.first] = false;
    }

    while (!s_bStopRequested) {
        // Обработка bind (keydown)
        for (auto& eh : g_eventHandlers) {
            UINT vk = eh.first;
            const std::wstring& funcName = eh.second;
            SHORT state = GetAsyncKeyState(vk);
            bool curr = (state & 0x8000) != 0;
            bool prev = prevState[vk];
            // Если клавиша только что нажата
            if (curr && !prev) {
                auto& running = g_functionRunning[funcName];
                if (!running.load(std::memory_order_acquire)) {
                    running.store(true, std::memory_order_release);
                    g_functionStopFlags[funcName].store(false, std::memory_order_release);
                    size_t len = funcName.size() + 1;
                    wchar_t* buf = new wchar_t[len];
                    wcscpy_s(buf, len, funcName.c_str());
                    HANDLE hThread = CreateThread(nullptr, 0, FunctionThreadProc, buf, 0, nullptr);
                    if (hThread) {
                        std::lock_guard<std::mutex> lock(g_threadMutex);
                        g_runningFunctionThreads[funcName] = hThread;
                    }
                }
            }
            prevState[vk] = curr;
        }

        // Обработка unbind (keyup)
        for (auto& uh : g_unbindHandlers) {
            UINT vk = uh.first;
            const std::wstring& funcName = uh.second;
            SHORT state = GetAsyncKeyState(vk);
            bool curr = (state & 0x8000) != 0;
            bool prev = prevStateUnbind[vk];
            // Если клавиша только что отпущена
            if (!curr && prev) {
                // Сброс всех виртуально зажатых клавиш для этой функции
                {
                    auto it = g_functionPressedKeys.find(funcName);
                    if (it != g_functionPressedKeys.end()) {
                        for (UINT vk_to_release : it->second) {
                            SendInputEvent(vk_to_release, false);
                        }
                        it->second.clear();
                        g_functionPressedKeys.erase(it);
                    }
                }
                // Принудительно завершить функцию (аналог disconnect)
                auto flagIt = g_functionStopFlags.find(funcName);
                if (flagIt != g_functionStopFlags.end()) {
                    flagIt->second.store(true, std::memory_order_release);
                }
                std::lock_guard<std::mutex> lock(g_threadMutex);
                auto thrIt = g_runningFunctionThreads.find(funcName);
                if (thrIt != g_runningFunctionThreads.end()) {
                    WaitForSingleObject(thrIt->second, 1000);
                    CloseHandle(thrIt->second);
                    g_runningFunctionThreads.erase(thrIt);
                }
                // Сбросить флаг запуска
                g_functionRunning[funcName].store(false, std::memory_order_release);
            }
            prevStateUnbind[vk] = curr;
        }

        Sleep(50);
    }

    return 0;
}

// Поток для выполнения одной функции по её имени
DWORD WINAPI FunctionThreadProc(LPVOID lpParam) {
    wchar_t* funcNameBuf = reinterpret_cast<wchar_t*>(lpParam);
    std::wstring funcName(funcNameBuf);
    delete[] funcNameBuf;

    auto it = g_functions.find(funcName);
    if (it == g_functions.end()) return 0;
    const std::vector<MacroCommand>& cmds = it->second;

    // Инициализация флага остановки
    g_functionStopFlags[funcName].store(false, std::memory_order_release);

    for (const auto& cmd : cmds) {
        if (s_bStopRequested) break;
        if (g_functionStopFlags[funcName].load(std::memory_order_acquire)) break;

        switch (cmd.type) {
        case CommandType::Press:
            // запоминаем, чтобы потом отпустить
            g_functionPressedKeys[funcName].push_back(cmd.vk);
            SendInputEvent(cmd.vk, true);
            break;

        case CommandType::Release:
            SendInputEvent(cmd.vk, false);
            break;

        case CommandType::Wait: {
            DWORD elapsed = 0;
            while (elapsed < cmd.time) {
                if (s_bStopRequested) break;
                if (g_functionStopFlags[funcName].load(std::memory_order_acquire)) break;
                DWORD remaining = cmd.time - elapsed;
                DWORD chunk = (remaining < 50) ? remaining : 50;
                Sleep(chunk);
                elapsed += chunk;
            }
            break;
        }
        case CommandType::Connect: {
            const std::wstring& subFunc = cmd.funcName;
            auto& running = g_functionRunning[subFunc];
            if (!running.load(std::memory_order_acquire)) {
                running.store(true, std::memory_order_release);
                g_functionStopFlags[subFunc].store(false, std::memory_order_release);
                size_t len = subFunc.size() + 1;
                wchar_t* buf = new wchar_t[len]; wcscpy_s(buf, len, subFunc.c_str());
                HANDLE h = CreateThread(nullptr, 0, FunctionThreadProc, buf, 0, nullptr);
                if (h) {
                    std::lock_guard<std::mutex> lock(g_threadMutex);
                    g_runningFunctionThreads[subFunc] = h;
                }
            }
            break;
        }
        case CommandType::Disconnect: {
            const std::wstring& target = cmd.funcName;
            auto flagIt = g_functionStopFlags.find(target);
            if (flagIt != g_functionStopFlags.end()) flagIt->second.store(true, std::memory_order_release);
            std::lock_guard<std::mutex> lock(g_threadMutex);
            auto thrIt = g_runningFunctionThreads.find(target);
            if (thrIt != g_runningFunctionThreads.end()) {
                WaitForSingleObject(thrIt->second, 1000);
                CloseHandle(thrIt->second);
                g_runningFunctionThreads.erase(thrIt);
            }
            break;
        }
        case CommandType::Message:
            MessageBox(g_hMainWnd, cmd.message.c_str(), L"Info", MB_OK | MB_ICONINFORMATION);
            break;
        default:
            break;
        }
    }

    // Очистка по завершении
    g_functionStopFlags.erase(funcName);
    {
        std::lock_guard<std::mutex> lock(g_threadMutex);
        auto thrIt = g_runningFunctionThreads.find(funcName);
        if (thrIt != g_runningFunctionThreads.end()) {
            CloseHandle(thrIt->second);
            g_runningFunctionThreads.erase(thrIt);
        }
    }
    g_functionRunning[funcName].store(false, std::memory_order_release);
    return 0;
}

// Поток выполнения основного макроса
DWORD WINAPI MacroThread(LPVOID lpParam) {
    wchar_t* macroText = (wchar_t*)lpParam;
    std::wstring macro(macroText);
    delete[] macroText;

    std::vector<std::wstring> lines;
    {
        std::wistringstream wiss(macro);
        std::wstring line;
        while (std::getline(wiss, line)) {
            if (!line.empty() && line.back() == L'\r')
                line.pop_back();
            lines.push_back(line);
        }
    }

    g_functions.clear();
    g_eventHandlers.clear();

    std::vector<std::wstring> mainLines;
    wchar_t* errorMsg = nullptr;
    int errorLine = 0;

    for (size_t idx = 0; idx < lines.size(); /* инкремент внутри */) {
        std::wstring raw0 = Trim(lines[idx]);
        int lineNum = static_cast<int>(idx + 1);
        if (raw0.empty() || raw0[0] == L'#') {
            idx++;
            continue;
        }
        std::wstring rawLower = raw0;
        for (size_t k = 0; k + 8 < rawLower.size(); k++) {
            if (rawLower[k] >= L'A' && rawLower[k] <= L'Z') rawLower[k] = towlower(rawLower[k]);
        }
        if (rawLower.size() >= 9 && rawLower.substr(0, 9) == L"function ") {
            size_t quoteStart = raw0.find(L'"', 9);
            if (quoteStart == std::wstring::npos) {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"Expected quotation mark for the function name (stroke: %d)", lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            size_t quoteEnd = raw0.find(L'"', quoteStart + 1);
            if (quoteEnd == std::wstring::npos) {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"The quotation mark for the function name is not closed (stroke: %d)", lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            std::wstring funcName = raw0.substr(quoteStart + 1, quoteEnd - quoteStart - 1);
            size_t j = idx + 1;
            bool foundEnd = false;
            for (; j < lines.size(); j++) {
                std::wstring t = Trim(lines[j]);
                std::wstring tLower = t;
                for (auto& ch : tLower) {
                    if (ch >= L'A' && ch <= L'Z') ch = towlower(ch);
                }
                if (tLower == L"end") {
                    foundEnd = true;
                    break;
                }
            }
            if (!foundEnd) {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"No 'end' found for %s function, (stroke: %d)", funcName.c_str(), lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            std::vector<std::wstring> funcLines;
            for (size_t k = idx + 1; k < j; k++) {
                funcLines.push_back(lines[k]);
            }
            std::vector<MacroCommand> funcCommands;
            if (!ParseCommandsRecursive(funcLines, 0, funcLines.size(), funcCommands, &errorMsg, errorLine)) {
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            g_functions[funcName] = funcCommands;
            idx = j + 1;
            continue;
        }
        if (rawLower.size() >= 5 && rawLower.substr(0, 5) == L"bind(") {
            size_t parenStart = raw0.find(L'(');
            size_t parenEnd = raw0.find(L')');
            if (parenStart == std::wstring::npos || parenEnd == std::wstring::npos || parenEnd <= parenStart + 1) {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"Syntax error in bind (stoke: %d)", lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            std::wstring args = Trim(raw0.substr(parenStart + 1, parenEnd - parenStart - 1));
            size_t commaPos = args.find(L',');
            if (commaPos == std::wstring::npos) {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"Expected comma in bind (stoke: %d)", lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            std::wstring keyPart = Trim(args.substr(0, commaPos));
            std::wstring funcPart = Trim(args.substr(commaPos + 1));
            if (keyPart.size() < 2 || keyPart.front() != L'"' || keyPart.back() != L'"') {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"The key must be in quotes (stoke: %d)", lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            std::wstring keyName = keyPart.substr(1, keyPart.size() - 2);
            UINT vk = StringToVK(keyName);
            if (vk == 0) {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"Unknown key in bind: '%s' (stoke: %d)", keyName.c_str(), lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            if (funcPart.size() < 2 || funcPart.front() != L'"' || funcPart.back() != L'"') {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"The function name must be in quotation marks (stoke: %d)", lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            std::wstring funcName = funcPart.substr(1, funcPart.size() - 2);
            if (g_functions.find(funcName) == g_functions.end()) {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"The function '%s' is not defined before bind (stoke: %d)", funcName.c_str(), lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            g_eventHandlers.push_back({ vk, funcName });
            idx++;
            continue;
        }
        // Обработка unbind("Клавиша", "ИмяФункции")
        if (rawLower.size() >= 7 && rawLower.substr(0, 7) == L"unbind(") {
            size_t parenStart = raw0.find(L'(');
            size_t parenEnd = raw0.rfind(L')');
            if (parenStart == std::wstring::npos || parenEnd == std::wstring::npos || parenEnd <= parenStart + 1) {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"Syntax error in unbind (stoke: %d)", lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            // Извлекаем текст между скобками
            std::wstring args = Trim(raw0.substr(parenStart + 1, parenEnd - parenStart - 1));
            size_t commaPos = args.find(L',');
            if (commaPos == std::wstring::npos) {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"Expected comma in unbind (stoke: %d)", lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            // Разбираем два аргумента
            std::wstring keyPart = Trim(args.substr(0, commaPos));
            std::wstring funcPart = Trim(args.substr(commaPos + 1));
            // Кавычки вокруг key
            if (keyPart.size() < 2 || keyPart.front() != L'"' || keyPart.back() != L'"') {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"The key must be in quotes (stoke: %d)", lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            // Кавычки вокруг funcName
            if (funcPart.size() < 2 || funcPart.front() != L'"' || funcPart.back() != L'"') {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"The function name must be in quotes (stoke: %d)", lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            std::wstring keyName = keyPart.substr(1, keyPart.size() - 2);
            std::wstring funcName = funcPart.substr(1, funcPart.size() - 2);
            // Преобразование имени клавиши в VK-код
            UINT vk = StringToVK(keyName);
            if (vk == 0) {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"Unknown key in unbind: '%s' (stoke: %d)", keyName.c_str(), lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            // Проверяем, что функция уже была определена
            if (g_functions.find(funcName) == g_functions.end()) {
                errorMsg = new wchar_t[256];
                wsprintf(errorMsg, L"The function '%s' is not defined before unbind (stoke: %d)", funcName.c_str(), lineNum);
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
                PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
                return 0;
            }
            // Регистрируем обработчик unbind
            g_unbindHandlers[vk] = funcName;

            idx++;
            continue;
        }
        mainLines.push_back(lines[idx]);
        idx++;
    }

    std::vector<MacroCommand> mainCommands;
    if (!ParseCommandsRecursive(mainLines, 0, mainLines.size(), mainCommands, &errorMsg, errorLine)) {
        PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(errorMsg));
        PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
        return 0;
    }

    HANDLE hEventThread = nullptr;
    if (!g_eventHandlers.empty()) {
        hEventThread = CreateThread(nullptr, 0, EventThreadProc, nullptr, 0, nullptr);
    }

    for (const auto& cmd : mainCommands) {
        if (s_bStopRequested) break;
        switch (cmd.type) {

        case CommandType::Press:
            SendInputEvent(cmd.vk, true);
            break;

        case CommandType::Release:
            SendInputEvent(cmd.vk, false);
            break;

        case CommandType::Wait: {
            DWORD elapsed = 0;
            while (elapsed < cmd.time) {
                if (s_bStopRequested) break;
                DWORD remaining = cmd.time - elapsed;
                DWORD chunk = (remaining < 50) ? remaining : 50;
                Sleep(chunk);
                elapsed += chunk;
            }
            break;
        }

        case CommandType::Connect: {
            const std::wstring& funcName = cmd.funcName;
            auto funcIt = g_functions.find(funcName);
            if (funcIt != g_functions.end()) {
                g_functionStopFlags[funcName] = false;
                size_t len = funcName.size() + 1;
                wchar_t* buf = new wchar_t[len];
                wcscpy_s(buf, len, funcName.c_str());
                HANDLE hThread = CreateThread(nullptr, 0, FunctionThreadProc, buf, 0, nullptr);
                if (hThread) {
                    g_runningFunctionThreads[funcName] = hThread;
                }
            }
            else {
                wchar_t* err = new wchar_t[256];
                wsprintf(err,
                    L"Error: connect to undefined function '%s' detected.",
                    funcName.c_str());
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(err));
                return 0;
            }
        } break;

        case CommandType::Disconnect: {
            const std::wstring& funcName = cmd.funcName;
            auto funcIt = g_functions.find(funcName);
            if (funcIt != g_functions.end()) {
                // Останавливаем поток
                auto flagIt = g_functionStopFlags.find(funcName);
                if (flagIt != g_functionStopFlags.end())
                    flagIt->second.store(true);
                auto thrIt = g_runningFunctionThreads.find(funcName);
                if (thrIt != g_runningFunctionThreads.end()) {
                    WaitForSingleObject(thrIt->second, 1000);
                    CloseHandle(thrIt->second);
                    g_runningFunctionThreads.erase(thrIt);
                }
                // Сброс всех виртуально зажатых клавиш для этой функции
                {
                    auto it = g_functionPressedKeys.find(funcName);
                    if (it != g_functionPressedKeys.end()) {
                        for (UINT vk_to_release : it->second) {
                            SendInputEvent(vk_to_release, false);
                        }
                        it->second.clear();
                        g_functionPressedKeys.erase(it);
                    }
                }
            }
            else {
                wchar_t* err = new wchar_t[256];
                wsprintf(err,
                    L"Error: disconnect from undefined function '%s' detected.",
                    funcName.c_str());
                PostMessage(g_hMainWnd, WM_MACRO_ERROR, 0, reinterpret_cast<LPARAM>(err));
                return 0;
            }
        } break;

        case CommandType::Message:
            MessageBox(
                g_hMainWnd,
                cmd.message.c_str(),
                L"Information",
                MB_OK | MB_ICONINFORMATION
            );
            break;

        default:
            break;
        }
    }

    if (g_eventHandlers.empty()) {
        s_bStopRequested = true;
    }
    else {
        while (!s_bStopRequested) {
            Sleep(100);
        }
    }

    if (hEventThread) {
        WaitForSingleObject(hEventThread, 5000);
        CloseHandle(hEventThread);
    }

    g_functions.clear();
    g_eventHandlers.clear();

    PostMessage(g_hMainWnd, WM_MACRO_FINISHED, 0, 0);
    return 0;
}

// Экспорт макроса в UTF-8 с BOM
void ExportMacro(HWND hwnd) {
    OPENFILENAME ofn = {};
    wchar_t szFile[MAX_PATH] = L"";
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = hwnd;
    ofn.lpstrFilter = L"Macros Files (*.macros)\0*.macros\0All Files (*.*)\0*.*\0";
    ofn.lpstrFile = szFile;
    ofn.nMaxFile = MAX_PATH;
    ofn.lpstrDefExt = L"macros";
    ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST;
    if (GetSaveFileName(&ofn)) {
        HWND hEdit = GetDlgItem(hwnd, ID_EDIT_BOX);
        if (!hEdit) return;
        int len = GetWindowTextLength(hEdit);
        std::wstring wtext;
        if (len > 0) {
            wtext.resize(len);
            GetWindowText(hEdit, &wtext[0], len + 1);
        }
        else {
            wtext.clear();
        }
        std::string utf8;
        if (!WStringToUTF8(wtext, utf8)) {
            MessageBox(hwnd, L"Error converting text to UTF-8!", L"Ошибка", MB_OK | MB_ICONERROR);
            return;
        }
        std::ofstream out(szFile, std::ios::binary);
        if (!out) {
            MessageBox(hwnd, L"Couldn't open the file for writing!", L"Ошибка", MB_OK | MB_ICONERROR);
            return;
        }
        const unsigned char bom[] = { 0xEF, 0xBB, 0xBF };
        out.write(reinterpret_cast<const char*>(bom), sizeof(bom));
        out.write(utf8.data(), (std::streamsize)utf8.size());
        out.close();
    }
}

// Импорт макроса из UTF-8 с BOM
void ImportMacro(HWND hwnd) {
    OPENFILENAME ofn = {};
    wchar_t szFile[MAX_PATH] = L"";
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = hwnd;
    ofn.lpstrFilter = L"Macros Files (*.macros)\0*.macros\0All Files (*.*)\0*.*\0";
    ofn.lpstrFile = szFile;
    ofn.nMaxFile = MAX_PATH;
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST;
    if (GetOpenFileName(&ofn)) {
        std::ifstream in(szFile, std::ios::binary);
        if (!in) {
            MessageBox(hwnd, L"Couldn't open the file for reading!", L"Ошибка", MB_OK | MB_ICONERROR);
            return;
        }
        std::vector<char> buffer;
        in.seekg(0, std::ios::end);
        std::streamsize sz = in.tellg();
        in.seekg(0, std::ios::beg);
        if (sz > 0) {
            buffer.resize((size_t)sz);
            in.read(buffer.data(), sz);
        }
        in.close();
        if (buffer.empty()) {
            HWND hEdit = GetDlgItem(hwnd, ID_EDIT_BOX);
            if (hEdit) SetWindowText(hEdit, L"");
            return;
        }
        size_t offset = 0;
        if (sz >= 3 &&
            (unsigned char)buffer[0] == 0xEF &&
            (unsigned char)buffer[1] == 0xBB &&
            (unsigned char)buffer[2] == 0xBF) {
            offset = 3;
        }
        std::string utf8;
        utf8.assign(buffer.begin() + offset, buffer.end());
        std::wstring wtext;
        if (!UTF8ToWString(utf8, wtext)) {
            MessageBox(hwnd, L"Error converting from UTF-8!", L"Ошибка", MB_OK | MB_ICONERROR);
            return;
        }
        HWND hEdit = GetDlgItem(hwnd, ID_EDIT_BOX);
        if (hEdit) {
            SetWindowText(hEdit, wtext.c_str());
        }
    }
}

// Процедура окна
LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_CREATE: {
        // Шрифты для заголовка и версии
        LOGFONT lfTitle = {};
        lfTitle.lfHeight = 32;
        lfTitle.lfWeight = FW_BOLD;
        wcscpy_s(lfTitle.lfFaceName, L"Segoe UI");
        hTitleFont = CreateFontIndirect(&lfTitle);
        g_titleHeight = abs(lfTitle.lfHeight) + 4;

        LOGFONT lfVersion = {};
        lfVersion.lfHeight = 16;
        lfVersion.lfWeight = FW_BOLD;
        wcscpy_s(lfVersion.lfFaceName, L"Segoe UI");
        hVersionFont = CreateFontIndirect(&lfVersion);
        return 0;
    }

    case WM_SIZE: {
        // Получаем размер клиентской области
        RECT rc;
        GetClientRect(hwnd, &rc);
        int width = rc.right;
        const int margin = 10;
        const int spacing = 10;

        // — Заголовок и '+'
        const wchar_t* titleText = L"Macros";
        HDC hdc = GetDC(hwnd);
        SelectObject(hdc, hTitleFont);
        SIZE szTitle;
        GetTextExtentPoint32(hdc, titleText, lstrlen(titleText), &szTitle);
        ReleaseDC(hwnd, hdc);
        int titleX = margin, titleY = margin;
        int plusX = titleX + szTitle.cx + 5;

        HWND hTitle = GetDlgItem(hwnd, ID_STATIC_TITLE);
        if (!hTitle) {
            hTitle = CreateWindowEx(
                0, L"STATIC", titleText,
                WS_CHILD | WS_VISIBLE | SS_LEFT,
                titleX, titleY, szTitle.cx, g_titleHeight,
                hwnd, (HMENU)ID_STATIC_TITLE,
                GetModuleHandle(nullptr), nullptr);
            SendMessage(hTitle, WM_SETFONT, (WPARAM)hTitleFont, TRUE);

            HWND hPlus = CreateWindowEx(
                0, L"STATIC", L"+",
                WS_CHILD | WS_VISIBLE | SS_LEFT,
                plusX, titleY, g_titleHeight, g_titleHeight,
                hwnd, (HMENU)ID_STATIC_PLUS,
                GetModuleHandle(nullptr), nullptr);
            SendMessage(hPlus, WM_SETFONT, (WPARAM)hTitleFont, TRUE);
        }
        else {
            MoveWindow(hTitle, titleX, titleY, szTitle.cx, g_titleHeight, FALSE);
            HWND hPlus = GetDlgItem(hwnd, ID_STATIC_PLUS);
            if (hPlus)
                MoveWindow(hPlus, plusX, titleY, g_titleHeight, g_titleHeight, FALSE);
        }

        // — Версия приложения
        HDC hdcVer = GetDC(hwnd);
        SelectObject(hdcVer, hVersionFont);
        SIZE szVer;
        GetTextExtentPoint32(hdcVer, APP_VERSION, lstrlen(APP_VERSION), &szVer);
        ReleaseDC(hwnd, hdcVer);
        int verX = width - margin - szVer.cx;
        int verY = margin;

        HWND hVer = GetDlgItem(hwnd, ID_STATIC_VERSION);
        if (!hVer) {
            hVer = CreateWindowEx(
                0, L"STATIC", APP_VERSION,
                WS_CHILD | WS_VISIBLE | SS_LEFT,
                verX, verY, szVer.cx, abs(16) + 4,
                hwnd, (HMENU)ID_STATIC_VERSION,
                GetModuleHandle(nullptr), nullptr);
            SendMessage(hVer, WM_SETFONT, (WPARAM)hVersionFont, TRUE);
        }
        else {
            SetWindowText(hVer, APP_VERSION);
            MoveWindow(hVer, verX, verY, szVer.cx, abs(16) + 4, FALSE);
        }

        // — Кнопки Import, Export, Start
        int btnCount = 3;
        int totalSpace = (btnCount - 1) * spacing;
        int availW = width - 2 * margin - totalSpace;
        int btnW = availW / btnCount;
        int btnY = titleY + g_titleHeight + margin;

        const wchar_t* btnTexts[3] = { L"Load", L"Save", L"Run" };  // <-- тут правим
        int btnIDs[3] = { ID_BUTTON_IMPORT, ID_BUTTON_EXPORT, ID_BUTTON_START };

        for (int i = 0; i < btnCount; ++i) {
            int x = margin + i * (btnW + spacing);
            HWND hBtn = GetDlgItem(hwnd, btnIDs[i]);
            if (!hBtn) {
                CreateThemedButton(hwnd, btnIDs[i], btnTexts[i], x, btnY, btnW, 30);
            }
            else {
                MoveWindow(hBtn, x, btnY, btnW, 30, FALSE);
            }
        }

        // — Кнопка Stop (создаём, если нужно)
        HWND hStop = GetDlgItem(hwnd, ID_BUTTON_STOP);
        if (!hStop) {
            hStop = CreateThemedButton(hwnd, ID_BUTTON_STOP, L"Stop",
                margin + 2 * (btnW + spacing),
                btnY, btnW, 30);
        }

        // Показываем/скрываем Start/Stop в зависимости от состояния s_bRunning
        ShowWindow(GetDlgItem(hwnd, ID_BUTTON_START), s_bRunning ? SW_HIDE : SW_SHOW);
        ShowWindow(hStop, s_bRunning ? SW_SHOW : SW_HIDE);

        // — Текстовое поле без рамки
        int editX = margin;
        int editY = btnY + 30 + margin;
        int editW = width - 2 * margin;
        int editH = rc.bottom - editY - margin;

        HWND hEdit = GetDlgItem(hwnd, ID_EDIT_BOX);
        if (!hEdit) {
            hEdit = CreateWindowEx(
                0,
                L"EDIT", L"",
                WS_CHILD | WS_VISIBLE |
                ES_MULTILINE | ES_AUTOVSCROLL |
                ES_LEFT | WS_VSCROLL,
                editX, editY, editW, editH,
                hwnd, (HMENU)ID_EDIT_BOX,
                GetModuleHandle(nullptr), nullptr);

            SendMessage(hEdit, EM_SETLIMITTEXT, 0x7FFFFFFE, 0);
            SendMessage(hEdit, WM_SETTEXT, 0, (LPARAM)INITIAL_TEXT);
        }
        else {
            MoveWindow(hEdit, editX, editY, editW, editH, FALSE);
        }

        // Перерисовать всё
        RedrawWindow(hwnd, NULL, NULL, RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
        break;
    }

    case WM_COMMAND: {
        int id = LOWORD(wParam);
        if (id == ID_BUTTON_IMPORT) {
            ImportMacro(hwnd);
        }
        else if (id == ID_BUTTON_EXPORT) {
            ExportMacro(hwnd);
        }
        else if (id == ID_BUTTON_START) {
            if (s_bRunning) break;
            HWND hEdit = GetDlgItem(hwnd, ID_EDIT_BOX);
            if (!hEdit) break;
            int len = GetWindowTextLength(hEdit);
            if (len <= 0) break;

            // 1. Флаг, что макрос запущен
            s_bRunning = true;
            s_bStopRequested = false;

            // 2. Кнопки Start/Stop
            ShowWindow(GetDlgItem(hwnd, ID_BUTTON_START), SW_HIDE);
            ShowWindow(GetDlgItem(hwnd, ID_BUTTON_STOP), SW_SHOW);

            // 3. Копируем текст и делаем Read‑Only
            wchar_t* text = new wchar_t[len + 1];
            GetWindowText(hEdit, text, len + 1);
            SendMessage(hEdit, EM_SETREADONLY, TRUE, 0);

            // === Убираем вертикальный скролл-бар ===
            LONG style = GetWindowLong(hEdit, GWL_STYLE);
            style &= ~WS_VSCROLL;                       // удаляем стиль
            SetWindowLong(hEdit, GWL_STYLE, style);
            ShowScrollBar(hEdit, SB_VERT, FALSE);       // скрываем
            SetWindowPos(hEdit, nullptr, 0, 0, 0, 0,        // пересоздаем рамку
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);

            // 4. Запускаем поток макроса
            s_hThread = CreateThread(nullptr, 0, MacroThread, text, 0, nullptr);
            if (!s_hThread) {
                // Откат при ошибке
                delete[] text;
                s_bRunning = false;
                ShowWindow(GetDlgItem(hwnd, ID_BUTTON_START), SW_SHOW);
                ShowWindow(GetDlgItem(hwnd, ID_BUTTON_STOP), SW_HIDE);
                SendMessage(hEdit, EM_SETREADONLY, FALSE, 0);

                // возвращаем скролл
                style = GetWindowLong(hEdit, GWL_STYLE);
                style |= WS_VSCROLL;
                SetWindowLong(hEdit, GWL_STYLE, style);
                ShowScrollBar(hEdit, SB_VERT, TRUE);
                SetWindowPos(hEdit, nullptr, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);

                MessageBox(hwnd, L"Thread start error!", L"Ошибка", MB_OK | MB_ICONERROR);
            }
        }
        else if (id == ID_BUTTON_STOP) {
            s_bStopRequested = true;
        }
        break;
    }

    case WM_MACRO_FINISHED: {
        // 1. Снимаем флаг работы
        s_bRunning = false;

        // 2. Закрываем поток
        if (s_hThread) {
            CloseHandle(s_hThread);
            s_hThread = nullptr;
        }

        // 3. Кнопки Start/Stop
        ShowWindow(GetDlgItem(hwnd, ID_BUTTON_START), SW_SHOW);
        ShowWindow(GetDlgItem(hwnd, ID_BUTTON_STOP), SW_HIDE);

        // 4. Снимаем Read‑Only
        HWND hEdit = GetDlgItem(hwnd, ID_EDIT_BOX);
        SendMessage(hEdit, EM_SETREADONLY, FALSE, 0);

        // === Восстанавливаем вертикальный скролл-бар ===
        LONG style = GetWindowLong(hEdit, GWL_STYLE);
        style |= WS_VSCROLL;                          // возвращаем стиль
        SetWindowLong(hEdit, GWL_STYLE, style);
        ShowScrollBar(hEdit, SB_VERT, TRUE);          // показываем
        SetWindowPos(hEdit, nullptr, 0, 0, 0, 0,          // пересоздаем рамку
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);

        break;
    }

    case WM_MACRO_ERROR: {
        wchar_t* msg = reinterpret_cast<wchar_t*>(lParam);
        if (msg) {
            MessageBox(hwnd, msg, L"Macros error!", MB_OK | MB_ICONERROR);
            delete[] msg;
        }
        PostMessage(hwnd, WM_MACRO_FINISHED, 0, 0);
        break;
    }

    case WM_CTLCOLORSTATIC: {
        HDC  hdc = (HDC)wParam;
        HWND ctl = (HWND)lParam;
        SetBkMode(hdc, TRANSPARENT);
        int ctrlId = GetDlgCtrlID(ctl);
        if (ctrlId == ID_STATIC_PLUS)
            SetTextColor(hdc, RGB(255, 255, 0));
        else if (ctrlId == ID_STATIC_VERSION)
            SetTextColor(hdc, RGB(55, 55, 55));
        else
            SetTextColor(hdc, RGB(255, 255, 255));
        return (LRESULT)hBackgroundBrush;
    }

    case WM_CTLCOLOREDIT: {
        HDC  hdc = (HDC)wParam;
        HWND ctl = (HWND)lParam;

        // Только для нашего поля
        if (GetDlgCtrlID(ctl) == ID_EDIT_BOX) {
            SetBkColor(hdc, RGB(45, 45, 45));
            if (s_bRunning) {
                SetTextColor(hdc, RGB(45, 45, 45));
            }
            else {
                SetTextColor(hdc, RGB(255, 255, 0));
            }
            return (LRESULT)hControlBrush;
        }
        break;
    }

    case WM_DRAWITEM: {
        LPDRAWITEMSTRUCT di = (LPDRAWITEMSTRUCT)lParam;
        if (di && di->hwndItem) {
            HDC  hdc = di->hDC;
            RECT rc = di->rcItem;
            HBRUSH brush = (di->itemState & ODS_SELECTED)
                ? CreateSolidBrush(RGB(35, 35, 35))
                : hControlBrush;
            FillRect(hdc, &rc, brush);
            if (di->itemState & ODS_SELECTED)
                DeleteObject(brush);

            SetBkMode(hdc, TRANSPARENT);

            // выбираем цвет текста по ID кнопки
            int ctrlId = GetDlgCtrlID(di->hwndItem);
            switch (ctrlId) {
            case ID_BUTTON_IMPORT:  // Load
                SetTextColor(hdc, RGB(255, 255, 255));
                break;
            case ID_BUTTON_EXPORT:  // Save
                SetTextColor(hdc, RGB(255, 255, 255));
                break;
            case ID_BUTTON_START:   // Run
                SetTextColor(hdc, RGB(255, 255, 0));
                break;
            case ID_BUTTON_STOP:    // Stop
                SetTextColor(hdc, RGB(205, 92, 92));
                break;
            default:
                SetTextColor(hdc, RGB(255, 255, 255));
                break;
            }

            // рисуем текст по центру
            wchar_t buf[256];
            GetWindowText(di->hwndItem, buf, _countof(buf));
            DrawText(hdc, buf, -1, &rc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
            return TRUE;
        }
        break;
    }

    case WM_DESTROY: {
        if (s_bRunning) {
            s_bStopRequested = true;
            if (s_hThread) {
                WaitForSingleObject(s_hThread, 5000);
                CloseHandle(s_hThread);
                s_hThread = nullptr;
            }
        }
        if (hBackgroundBrush) { DeleteObject(hBackgroundBrush); hBackgroundBrush = nullptr; }
        if (hControlBrush) { DeleteObject(hControlBrush);    hControlBrush = nullptr; }
        if (hTitleFont) { DeleteObject(hTitleFont);       hTitleFont = nullptr; }
        if (hVersionFont) { DeleteObject(hVersionFont);     hVersionFont = nullptr; }
        PostQuitMessage(0);
        return 0;
    }
    }

    return DefWindowProc(hwnd, msg, wParam, lParam);
}

// Запуск GUI: регистрация класса, создание окна и цикл сообщений
int RunGui(HINSTANCE hInstance, int nCmdShow) {
    // Фон и кисти для контролов
    hBackgroundBrush = CreateSolidBrush(RGB(35, 35, 35));
    hControlBrush = CreateSolidBrush(RGB(45, 45, 45));

    // Регистрация класса окна
    WNDCLASSEX wc = {};
    wc.cbSize = sizeof(wc);
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInstance;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = hBackgroundBrush;
    wc.lpszClassName = L"MacroPlusClass";

    if (!RegisterClassEx(&wc)) {
        MessageBox(nullptr, L"The window class could not be registered!", L"Ошибка", MB_OK | MB_ICONERROR);
        return -1;
    }

    // Создаём главное окно:
    // - WS_EX_TOPMOST       — всегда поверх всех окон
    // - WS_OVERLAPPEDWINDOW без WS_THICKFRAME и WS_MAXIMIZEBOX — фиксированный размер, без возможности максимизировать
    g_hMainWnd = CreateWindowEx(
        WS_EX_TOPMOST,
        wc.lpszClassName,
        L"Macros Plus",
        (WS_OVERLAPPEDWINDOW & ~WS_THICKFRAME & ~WS_MAXIMIZEBOX),
        CW_USEDEFAULT, CW_USEDEFAULT, 500, 400,
        nullptr, nullptr, hInstance, nullptr
    );

    if (!g_hMainWnd) {
        MessageBox(nullptr, L"Couldn't create the main window!", L"Ошибка", MB_OK | MB_ICONERROR);
        return -1;
    }

    ShowWindow(g_hMainWnd, nCmdShow);
    UpdateWindow(g_hMainWnd);

    MSG msg;
    while (GetMessage(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    return static_cast<int>(msg.wParam);
}

// Точка входа для оконного приложения (скрываем консоль)
int main() {
    FreeConsole();
    HINSTANCE hInst = GetModuleHandle(nullptr);
    int exitCode = RunGui(hInst, SW_SHOWDEFAULT);
    return exitCode;
}

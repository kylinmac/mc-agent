//! Window identity, desktop and integrity checks. No elevation or shell launch.
use crate::backend::{AppInfo, Point};
use anyhow::{anyhow, bail, Context, Result};
use std::{
    path::{Component, Path, PathBuf, Prefix},
    time::{Duration, Instant},
};
use windows::{
    core::{BOOL, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
        Security::{
            GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
            TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
        },
        System::{StationsAndDesktops::*, Threading::*},
        UI::WindowsAndMessaging::*,
    },
};

pub struct Handle(pub HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[derive(Clone)]
pub struct Window {
    pub hwnd: HWND,
    pub app: AppInfo,
    pub title: String,
}

pub fn pid(hwnd: HWND) -> u32 {
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    pid
}

pub fn desktop_ready() -> Result<()> {
    unsafe {
        // GetThreadDesktop returns a borrowed handle. UOI_IO is a read-only
        // check: never switch/open another desktop to probe a permission.
        let desktop = GetThreadDesktop(GetCurrentThreadId())?;
        let mut receives_input = BOOL(0);
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_IO,
            Some(&mut receives_input as *mut _ as _),
            size_of::<BOOL>() as u32,
            None,
        )
        .context("Cannot inspect this thread's interactive desktop")?;
        if !receives_input.as_bool() {
            bail!("Windows is locked, disconnected or a secure desktop is active. Ask the user to unlock it; this helper will not switch desktops.");
        }
    }
    Ok(())
}

fn integrity(process: HANDLE) -> Result<u32> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token)?;
        let token = Handle(token);
        let mut needed = 0;
        let _ = GetTokenInformation(token.0, TokenIntegrityLevel, None, 0, &mut needed);
        if needed == 0 || needed > 65536 {
            bail!("Cannot determine process integrity level");
        }
        // usize storage preserves the alignment of TOKEN_MANDATORY_LABEL.
        let mut buffer = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
        GetTokenInformation(
            token.0,
            TokenIntegrityLevel,
            Some(buffer.as_mut_ptr().cast()),
            needed,
            &mut needed,
        )?;
        let label = &*buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
        let count = *GetSidSubAuthorityCount(label.Label.Sid);
        if count == 0 {
            bail!("Invalid integrity SID");
        }
        Ok(*GetSidSubAuthority(label.Label.Sid, u32::from(count - 1)))
    }
}

pub fn check_window(window: &Window) -> Result<()> {
    desktop_ready()?;
    unsafe {
        if !IsWindow(Some(window.hwnd)).as_bool() || pid(window.hwnd) != window.app.pid as u32 {
            bail!("The window has closed or changed. Read get_app_state again.");
        }
        let process = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, window.app.pid as u32)
            .context("Cannot inspect the target process; protected or elevated applications are unsupported")?);
        if integrity(process.0)? > integrity(GetCurrentProcess())? {
            bail!("The target runs at a higher integrity level (UIPI). Use a normal, non-elevated app; mc-agent will not elevate.");
        }
    }
    Ok(())
}

pub fn frame(hwnd: HWND) -> Result<RECT> {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            bail!("The window is minimized. Restore it and read its state again.");
        }
        let mut rect = RECT::default();
        // DWM excludes invisible resize borders, including the negative border
        // around a maximized window, and returns physical pixel coordinates.
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as _,
            size_of::<RECT>() as u32,
        )?;
        if rect.right <= rect.left || rect.bottom <= rect.top {
            bail!("Window has no drawable area");
        }
        Ok(rect)
    }
}

pub fn foreground(window: &Window) -> Result<()> {
    check_window(window)?;
    unsafe {
        if IsIconic(window.hwnd).as_bool() {
            let _ = ShowWindow(window.hwnd, SW_RESTORE);
        }
        if GetForegroundWindow() != window.hwnd {
            let _ = SetForegroundWindow(window.hwnd);
            std::thread::sleep(Duration::from_millis(120));
        }
        if GetForegroundWindow() != window.hwnd {
            bail!("Windows refused foreground activation. Bring the target window to the front, then retry.");
        }
    }
    Ok(())
}

pub fn require_foreground(window: &Window) -> Result<()> {
    check_window(window)?;
    if unsafe { GetForegroundWindow() } != window.hwnd {
        bail!("Focus changed; input cancelled. Read the target app again.");
    }
    Ok(())
}

pub fn hit(window: &Window, point: Point) -> Result<()> {
    require_foreground(window)?;
    unsafe {
        let hit = WindowFromPoint(POINT {
            x: point.x.round() as i32,
            y: point.y.round() as i32,
        });
        if hit.0.is_null() || GetAncestor(hit, GA_ROOT) != window.hwnd {
            bail!("The point is outside the target window or covered by another window; read a fresh state.");
        }
    }
    Ok(())
}

unsafe extern "system" fn enumerate(hwnd: HWND, param: LPARAM) -> BOOL {
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return true.into();
    }
    let mut title = vec![0u16; 1024];
    let len = unsafe { GetWindowTextW(hwnd, &mut title) };
    if len == 0 {
        return true.into();
    }
    let process_id = pid(hwnd);
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) };
    let Ok(process) = process else {
        return true.into();
    };
    let process = Handle(process);
    let mut path = vec![0u16; 32768];
    let mut len_path = path.len() as u32;
    if unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut len_path,
        )
    }
    .is_err()
    {
        return true.into();
    }
    let path = String::from_utf16_lossy(&path[..len_path as usize]);
    let name = Path::new(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| process_id.to_string());
    let windows = unsafe { &mut *(param.0 as *mut Vec<Window>) };
    windows.push(Window {
        hwnd,
        title: String::from_utf16_lossy(&title[..len as usize]),
        app: AppInfo {
            name,
            pid: i64::from(process_id),
            path: Some(path),
            frontmost: unsafe { GetForegroundWindow() } == hwnd,
        },
    });
    true.into()
}

pub fn windows() -> Result<Vec<Window>> {
    desktop_ready()?;
    let mut windows = Vec::<Window>::new();
    unsafe {
        EnumWindows(Some(enumerate), LPARAM(&mut windows as *mut _ as isize))?;
    }
    windows.sort_by_key(|w| !w.app.frontmost);
    Ok(windows)
}

fn matches(window: &Window, app: &str) -> bool {
    window.app.pid.to_string() == app
        || window.app.name.eq_ignore_ascii_case(app)
        || window.app.path.as_ref().is_some_and(|p| {
            p.eq_ignore_ascii_case(app)
                || Path::new(p)
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(app))
        })
}

pub fn resolve(app: &str) -> Result<Window> {
    let find = || -> Result<Option<Window>> {
        let matches: Vec<_> = windows()?.into_iter().filter(|w| matches(w, app)).collect();
        if matches.iter().any(|w| w.app.pid != matches[0].app.pid) {
            bail!("Several processes match this app. Use the pid from list_apps.");
        }
        Ok(matches.into_iter().next())
    };
    if let Some(window) = find()? {
        return Ok(window);
    }
    let path = launch_path(app)?;
    use std::os::windows::process::CommandExt;
    let mut child = std::process::Command::new(path)
        .creation_flags(0x08000000)
        .spawn()
        .context("Cannot launch app")?;
    // Reap without terminating the app when this MCP server exits.
    std::thread::spawn(move || {
        if let Err(error) = child.wait() {
            eprintln!("mc-computer: waiting for launched app: {error}");
        }
    });
    let until = Instant::now() + Duration::from_secs(8);
    while Instant::now() < until {
        if let Some(window) = find()? {
            return Ok(window);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(anyhow!(
        "App launched but no accessible window appeared within 8 seconds"
    ))
}

fn local_executable_path(path: &Path) -> bool {
    path.is_absolute()
        && matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        && path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
}

fn launch_path(app: &str) -> Result<PathBuf> {
    let path = Path::new(app);
    if !local_executable_path(path) {
        bail!("App not found. Use a pid/name from list_apps, or an absolute local .exe path to launch it (no arguments).");
    }
    let canonical = path
        .canonicalize()
        .context("Executable path does not exist")?;
    if !local_executable_path(&canonical) || !canonical.is_file() {
        bail!("Executable must resolve to a local .exe file, not a network/device path");
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_requires_local_absolute_executable_without_arguments() {
        for path in [r"C:\Apps\Test.exe", r"\\?\C:\Apps\Test.EXE"] {
            assert!(local_executable_path(Path::new(path)));
        }
        for path in [
            "calc.exe",
            r"C:calc.exe",
            r"\\server\share\test.exe",
            "//server/share/test.exe",
            r"\\?\UNC\server\share\test.exe",
            r"C:\Apps\test.cmd",
            r"C:\Apps\test.exe --flag",
            "https://example.com/test.exe",
        ] {
            assert!(!local_executable_path(Path::new(path)), "{path}");
        }
    }
    #[test]
    fn app_matching_does_not_guess_by_substring_or_title() {
        let window = Window {
            hwnd: HWND::default(),
            title: "Some document".into(),
            app: AppInfo {
                name: "notepad".into(),
                pid: 42,
                path: Some(r"C:\Windows\notepad.exe".into()),
                frontmost: false,
            },
        };
        for app in ["42", "NOTEPAD", "notepad.exe", r"C:\Windows\notepad.exe"] {
            assert!(matches(&window, app));
        }
        for app in ["note", "Some document", "0", "notepad.exe --flag"] {
            assert!(!matches(&window, app));
        }
    }
}

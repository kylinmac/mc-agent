//! SendInput with verified foreground ownership and best-effort release on error.
use super::native::{self, Window};
use crate::{
    backend::{Direction, MouseButton, Point},
    keys::{Key, KeyChord, Named},
};
use anyhow::{bail, Result};
use windows::Win32::UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*};

fn key(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                ..Default::default()
            },
        },
    }
}
fn mouse(flags: MOUSE_EVENT_FLAGS, data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flags,
                mouseData: data,
                ..Default::default()
            },
        },
    }
}
fn send(events: &[INPUT]) -> Result<()> {
    let sent = unsafe { SendInput(events, size_of::<INPUT>() as i32) };
    if sent != events.len() as u32 {
        bail!("Windows refused some input events (possibly UIPI); action stopped");
    }
    Ok(())
}
fn release(events: &[INPUT]) {
    if let Err(error) = send(events) {
        eprintln!("mc-computer: input release failed: {error}");
    }
}

fn require_released_modifiers() -> Result<()> {
    for key in [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN] {
        if unsafe { GetAsyncKeyState(i32::from(key.0)) } < 0 {
            bail!(
                "A modifier key is held. Release it before automated input; no keys were changed."
            );
        }
    }
    Ok(())
}

fn move_to(window: &Window, point: Point) -> Result<()> {
    native::hit(window, point)?;
    unsafe {
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if width <= 1 || height <= 1 {
            bail!("Invalid virtual desktop size");
        }
        let mut event = mouse(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            0,
        );
        event.Anonymous.mi.dx =
            ((point.x - f64::from(left)) * 65535.0 / f64::from(width - 1)).round() as i32;
        event.Anonymous.mi.dy =
            ((point.y - f64::from(top)) * 65535.0 / f64::from(height - 1)).round() as i32;
        send(&[event])
    }
}

pub fn click(window: &Window, point: Point, button: MouseButton, count: u32) -> Result<()> {
    require_released_modifiers()?;
    move_to(window, point)?;
    let (down, up) = match button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    };
    for _ in 0..count {
        native::hit(window, point)?;
        if let Err(error) = send(&[mouse(down, 0), mouse(up, 0)]) {
            release(&[mouse(up, 0)]);
            return Err(error);
        }
    }
    Ok(())
}

pub fn drag(window: &Window, from: Point, to: Point) -> Result<()> {
    require_released_modifiers()?;
    native::hit(window, to)?;
    move_to(window, from)?;
    let result = (|| {
        send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0)])?;
        for step in 1..=20 {
            move_to(
                window,
                Point {
                    x: from.x + (to.x - from.x) * f64::from(step) / 20.0,
                    y: from.y + (to.y - from.y) * f64::from(step) / 20.0,
                },
            )?;
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        Ok(())
    })();
    let released = send(&[mouse(MOUSEEVENTF_LEFTUP, 0)]);
    result.and(released)
}

pub fn text(window: &Window, text: &str, check_focus: impl Fn() -> Result<()>) -> Result<()> {
    require_released_modifiers()?;
    for ch in text.replace("\r\n", "\n").chars() {
        native::require_foreground(window)?;
        check_focus()?;
        let mut units = [0; 2];
        let events = if ch == '\n' || ch == '\t' {
            let vk = if ch == '\n' { VK_RETURN } else { VK_TAB };
            vec![
                key(vk, 0, KEYBD_EVENT_FLAGS(0)),
                key(vk, 0, KEYEVENTF_KEYUP),
            ]
        } else {
            ch.encode_utf16(&mut units)
                .iter()
                .flat_map(|unit| {
                    [
                        key(VIRTUAL_KEY(0), *unit, KEYEVENTF_UNICODE),
                        key(VIRTUAL_KEY(0), *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
                    ]
                })
                .collect()
        };
        if let Err(error) = send(&events) {
            let ups: Vec<_> = events
                .iter()
                .copied()
                .filter(|e| unsafe { e.Anonymous.ki.dwFlags.contains(KEYEVENTF_KEYUP) })
                .collect();
            release(&ups);
            return Err(error);
        }
    }
    Ok(())
}

fn virtual_key(window: &Window, chord: &KeyChord) -> Result<(VIRTUAL_KEY, u8)> {
    let code = match chord.key {
        Key::Char(ch) => {
            let mapped = unsafe {
                let thread = GetWindowThreadProcessId(window.hwnd, None);
                VkKeyScanExW(ch as u16, GetKeyboardLayout(thread))
            };
            if mapped == -1 {
                bail!("This key is unavailable in the active keyboard layout; use type_text");
            }
            return Ok((
                VIRTUAL_KEY(mapped as u16 & 0xff),
                ((mapped as u16 >> 8) & 7) as u8,
            ));
        }
        Key::Function(n) => VIRTUAL_KEY(VK_F1.0 + u16::from(n) - 1),
        Key::Named(name) => match name {
            Named::Return | Named::KeypadEnter => VK_RETURN,
            Named::Tab => VK_TAB,
            Named::Space => VK_SPACE,
            Named::Backspace => VK_BACK,
            Named::Delete => VK_DELETE,
            Named::Escape => VK_ESCAPE,
            Named::Left => VK_LEFT,
            Named::Right => VK_RIGHT,
            Named::Up => VK_UP,
            Named::Down => VK_DOWN,
            Named::Home => VK_HOME,
            Named::End => VK_END,
            Named::PageUp => VK_PRIOR,
            Named::PageDown => VK_NEXT,
        },
    };
    Ok((code, 0))
}

pub fn chord(window: &Window, chord: &KeyChord) -> Result<()> {
    require_released_modifiers()?;
    let (vk, implicit) = virtual_key(window, chord)?;
    let m = chord.modifiers;
    let mut keys = Vec::new();
    if m.control || implicit & 2 != 0 {
        keys.push(VK_CONTROL);
    }
    if m.alt || implicit & 4 != 0 {
        keys.push(VK_MENU);
    }
    if m.shift || implicit & 1 != 0 {
        keys.push(VK_SHIFT);
    }
    if m.command {
        keys.push(VK_LWIN);
    }
    keys.push(vk);
    let extended = |k| {
        if [
            VK_LEFT, VK_RIGHT, VK_UP, VK_DOWN, VK_HOME, VK_END, VK_PRIOR, VK_NEXT, VK_DELETE,
            VK_LWIN,
        ]
        .contains(&k)
            || (k == VK_RETURN && chord.key == Key::Named(Named::KeypadEnter))
        {
            KEYEVENTF_EXTENDEDKEY
        } else {
            KEYBD_EVENT_FLAGS(0)
        }
    };
    let ups: Vec<_> = keys
        .iter()
        .rev()
        .map(|k| key(*k, 0, extended(*k) | KEYEVENTF_KEYUP))
        .collect();
    let mut events: Vec<_> = keys.iter().map(|k| key(*k, 0, extended(*k))).collect();
    events.extend_from_slice(&ups);
    native::require_foreground(window)?;
    if let Err(error) = send(&events) {
        release(&ups);
        return Err(error);
    }
    Ok(())
}

pub fn scroll(window: &Window, at: Point, direction: Direction, pages: f64) -> Result<()> {
    require_released_modifiers()?;
    move_to(window, at)?;
    native::hit(window, at)?;
    let sign = match direction {
        Direction::Up | Direction::Right => 1.0,
        _ => -1.0,
    };
    let flags = match direction {
        Direction::Left | Direction::Right => MOUSEEVENTF_HWHEEL,
        _ => MOUSEEVENTF_WHEEL,
    };
    send(&[mouse(
        flags,
        (sign * pages * 3.0 * 120.0).round() as i32 as u32,
    )])
}

//! Synthesized input: mouse, keyboard and scroll events through CGEvent.

use std::thread::sleep;
use std::time::Duration;

use anyhow::{anyhow, Result};

use super::ffi::*;
use crate::keys::{Key, KeyChord, Modifiers, Named};

fn post(event: CGEventRef) -> Result<()> {
    if event.is_null() {
        return Err(anyhow!("the system refused to create an input event"));
    }
    // SAFETY: a fresh +1 event; posted, then released.
    unsafe {
        CGEventPost(kCGHIDEventTap, event);
        core_foundation_sys::base::CFRelease(event as _);
    }
    Ok(())
}

fn mouse(kind: u32, at: CGPoint, button: u32, clicks: i64) -> Result<()> {
    // SAFETY: plain constructor; null source is allowed.
    let event = unsafe { CGEventCreateMouseEvent(std::ptr::null(), kind, at, button) };
    if !event.is_null() && clicks > 0 {
        // SAFETY: live event.
        unsafe { CGEventSetIntegerValueField(event, kCGMouseEventClickState, clicks) };
    }
    post(event)
}

pub fn move_to(at: CGPoint) -> Result<()> {
    mouse(kCGEventMouseMoved, at, kCGMouseButtonLeft, 0)
}

/// `count` clicks at a point (2 = double click), left or right.
pub fn click(at: CGPoint, right: bool, count: u32) -> Result<()> {
    let (down, up, button) = if right {
        (
            kCGEventRightMouseDown,
            kCGEventRightMouseUp,
            kCGMouseButtonRight,
        )
    } else {
        (
            kCGEventLeftMouseDown,
            kCGEventLeftMouseUp,
            kCGMouseButtonLeft,
        )
    };
    move_to(at)?;
    sleep(Duration::from_millis(30));
    for n in 1..=count.max(1) as i64 {
        mouse(down, at, button, n)?;
        sleep(Duration::from_millis(15));
        mouse(up, at, button, n)?;
        sleep(Duration::from_millis(40));
    }
    Ok(())
}

pub fn drag(from: CGPoint, to: CGPoint) -> Result<()> {
    move_to(from)?;
    sleep(Duration::from_millis(30));
    mouse(kCGEventLeftMouseDown, from, kCGMouseButtonLeft, 1)?;
    const STEPS: usize = 16;
    for step in 1..=STEPS {
        let t = step as f64 / STEPS as f64;
        let at = CGPoint {
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t,
        };
        sleep(Duration::from_millis(12));
        mouse(kCGEventLeftMouseDragged, at, kCGMouseButtonLeft, 1)?;
    }
    sleep(Duration::from_millis(30));
    mouse(kCGEventLeftMouseUp, to, kCGMouseButtonLeft, 1)
}

/// Scroll at a point: `lines` vertical (positive is up), `columns` horizontal (positive is left).
pub fn scroll(at: CGPoint, lines: i32, columns: i32) -> Result<()> {
    move_to(at)?;
    sleep(Duration::from_millis(30));
    // Several small events scroll more smoothly than one large one.
    let steps = lines
        .unsigned_abs()
        .max(columns.unsigned_abs())
        .clamp(1, 60);
    for step in 0..steps {
        let part = |total: i32| -> i32 {
            let base = total / steps as i32;
            let extra = if (step as i32) < (total.abs() % steps as i32) {
                total.signum()
            } else {
                0
            };
            base + extra
        };
        // SAFETY: plain constructor.
        let event = unsafe {
            CGEventCreateScrollWheelEvent2(
                std::ptr::null(),
                kCGScrollEventUnitLine,
                2,
                part(lines),
                part(columns),
                0,
            )
        };
        post(event)?;
        sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn flags(modifiers: &Modifiers) -> u64 {
    let mut flags = 0;
    if modifiers.command {
        flags |= kCGEventFlagMaskCommand;
    }
    if modifiers.control {
        flags |= kCGEventFlagMaskControl;
    }
    if modifiers.alt {
        flags |= kCGEventFlagMaskAlternate;
    }
    if modifiers.shift {
        flags |= kCGEventFlagMaskShift;
    }
    flags
}

/// Virtual key code on an ANSI (US) keyboard.
pub fn keycode(key: &Key) -> Option<u16> {
    let code = match key {
        Key::Named(named) => match named {
            Named::Return => 36,
            Named::Tab => 48,
            Named::Space => 49,
            Named::Backspace => 51,
            Named::Escape => 53,
            Named::Delete => 117,
            Named::Home => 115,
            Named::PageUp => 116,
            Named::End => 119,
            Named::PageDown => 121,
            Named::Left => 123,
            Named::Right => 124,
            Named::Down => 125,
            Named::Up => 126,
            Named::KeypadEnter => 76,
        },
        Key::Function(n) => match n {
            1 => 122,
            2 => 120,
            3 => 99,
            4 => 118,
            5 => 96,
            6 => 97,
            7 => 98,
            8 => 100,
            9 => 101,
            10 => 109,
            11 => 103,
            12 => 111,
            13 => 105,
            14 => 107,
            15 => 113,
            16 => 106,
            17 => 64,
            18 => 79,
            19 => 80,
            20 => 90,
            _ => return None,
        },
        Key::Char(c) => match c {
            'a' => 0,
            's' => 1,
            'd' => 2,
            'f' => 3,
            'h' => 4,
            'g' => 5,
            'z' => 6,
            'x' => 7,
            'c' => 8,
            'v' => 9,
            'b' => 11,
            'q' => 12,
            'w' => 13,
            'e' => 14,
            'r' => 15,
            'y' => 16,
            't' => 17,
            '1' | '!' => 18,
            '2' | '@' => 19,
            '3' | '#' => 20,
            '4' | '$' => 21,
            '6' | '^' => 22,
            '5' | '%' => 23,
            '=' | '+' => 24,
            '9' | '(' => 25,
            '7' | '&' => 26,
            '-' | '_' => 27,
            '8' | '*' => 28,
            '0' | ')' => 29,
            ']' | '}' => 30,
            'o' => 31,
            'u' => 32,
            '[' | '{' => 33,
            'i' => 34,
            'p' => 35,
            'l' => 37,
            'j' => 38,
            '\'' | '"' => 39,
            'k' => 40,
            ';' | ':' => 41,
            '\\' | '|' => 42,
            ',' | '<' => 43,
            '/' | '?' => 44,
            'n' => 45,
            'm' => 46,
            '.' | '>' => 47,
            '`' | '~' => 50,
            _ => return None,
        },
    };
    Some(code)
}

/// Characters that need shift on a US layout.
fn shifted(c: char) -> bool {
    "!@#$%^&*()_+{}|:\"<>?~".contains(c)
}

fn key_event(code: u16, down: bool, flags_mask: u64) -> Result<()> {
    // SAFETY: plain constructor.
    let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), code, down) };
    if !event.is_null() {
        // SAFETY: live event. Always set, so stale physical modifiers do not leak in.
        unsafe { CGEventSetFlags(event, flags_mask) };
    }
    post(event)
}

pub fn press(chord: &KeyChord) -> Result<()> {
    let code = keycode(&chord.key).ok_or_else(|| anyhow!("this key has no key code on macOS"))?;
    let mut modifiers = chord.modifiers;
    if let Key::Char(c) = chord.key {
        modifiers.shift |= shifted(c);
    }
    let mask = flags(&modifiers);
    key_event(code, true, mask)?;
    sleep(Duration::from_millis(20));
    key_event(code, false, mask)
}

/// Type text as key events carrying the characters themselves, so any
/// script works whatever the keyboard layout. `\n` presses Return, `\t` Tab.
pub fn type_text(text: &str) -> Result<()> {
    let mut chunk: Vec<u16> = Vec::new();
    let flush = |chunk: &mut Vec<u16>| -> Result<()> {
        for piece in chunk.chunks(16) {
            for down in [true, false] {
                // SAFETY: plain constructor; the buffer outlives the call.
                let event = unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), 0, down) };
                if !event.is_null() {
                    unsafe {
                        CGEventSetFlags(event, 0);
                        CGEventKeyboardSetUnicodeString(event, piece.len(), piece.as_ptr());
                    }
                }
                post(event)?;
            }
            sleep(Duration::from_millis(8));
        }
        chunk.clear();
        Ok(())
    };
    for c in text.chars() {
        match c {
            '\n' | '\r' => {
                flush(&mut chunk)?;
                if c == '\n' {
                    press(&KeyChord {
                        modifiers: Modifiers::default(),
                        key: Key::Named(Named::Return),
                    })?;
                }
            }
            '\t' => {
                flush(&mut chunk)?;
                press(&KeyChord {
                    modifiers: Modifiers::default(),
                    key: Key::Named(Named::Tab),
                })?;
            }
            _ => {
                let mut units = [0u16; 2];
                chunk.extend_from_slice(c.encode_utf16(&mut units));
            }
        }
    }
    flush(&mut chunk)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::parse_chord;

    #[test]
    fn common_keys_have_codes() {
        for raw in [
            "Return",
            "Tab",
            "Escape",
            "cmd+c",
            "cmd+v",
            "cmd+shift+t",
            "Left",
            "F5",
            "ctrl+a",
            "cmd+=",
            "Delete",
        ] {
            let chord = parse_chord(raw).unwrap();
            assert!(keycode(&chord.key).is_some(), "{raw}");
        }
        assert_eq!(keycode(&Key::Char('a')), Some(0));
        assert_eq!(keycode(&Key::Named(Named::Return)), Some(36));
    }

    #[test]
    fn modifier_flags_combine() {
        let chord = parse_chord("cmd+shift+t").unwrap();
        assert_eq!(
            flags(&chord.modifiers),
            kCGEventFlagMaskCommand | kCGEventFlagMaskShift
        );
        assert!(shifted('?') && !shifted('/'));
    }
}

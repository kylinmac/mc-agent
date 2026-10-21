//! Key chords in the familiar `cmd+shift+t` / xdotool style, parsed once
//! into a platform-neutral form; each backend maps [`Key`] to its own codes.

use anyhow::{anyhow, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modifiers {
    /// ⌘ on macOS, the Windows key on Windows.
    pub command: bool,
    pub control: bool,
    /// ⌥ on macOS, Alt on Windows.
    pub alt: bool,
    pub shift: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    /// A printable character on a US layout: letters, digits, punctuation.
    Char(char),
    Named(Named),
    /// F1–F20.
    Function(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Named {
    Return,
    Tab,
    Space,
    Backspace,
    Delete,
    Escape,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    KeypadEnter,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyChord {
    pub modifiers: Modifiers,
    pub key: Key,
}

fn named(name: &str) -> Option<Key> {
    let key = match name {
        "return" | "enter" => Named::Return,
        "tab" => Named::Tab,
        "space" => Named::Space,
        "backspace" => Named::Backspace,
        "delete" | "forwarddelete" | "del" => Named::Delete,
        "escape" | "esc" => Named::Escape,
        "left" => Named::Left,
        "right" => Named::Right,
        "up" => Named::Up,
        "down" => Named::Down,
        "home" => Named::Home,
        "end" => Named::End,
        "pageup" | "page_up" | "prior" => Named::PageUp,
        "pagedown" | "page_down" | "next" => Named::PageDown,
        "kp_enter" | "keypadenter" => Named::KeypadEnter,
        _ => return None,
    };
    Some(Key::Named(key))
}

/// Parse `"cmd+shift+t"`, `"Return"`, `"ctrl+c"`, `"F5"`, `"super+c"`.
pub fn parse_chord(raw: &str) -> Result<KeyChord> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("key is empty"));
    }
    // "+" alone, or ending in "++", means the plus key itself.
    let (head, last) = if trimmed == "+" {
        ("", "+")
    } else if let Some(prefix) = trimmed.strip_suffix("++") {
        (prefix, "+")
    } else {
        match trimmed.rsplit_once('+') {
            Some((head, last)) => (head, last),
            None => ("", trimmed),
        }
    };
    let mut modifiers = Modifiers::default();
    for part in head
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        match part.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "super" | "meta" | "win" | "windows" => modifiers.command = true,
            "ctrl" | "control" => modifiers.control = true,
            "alt" | "option" | "opt" => modifiers.alt = true,
            "shift" => modifiers.shift = true,
            other => return Err(anyhow!("unknown modifier \"{other}\" in \"{raw}\"")),
        }
    }
    let last = last.trim();
    let lower = last.to_ascii_lowercase();
    let key = if let Some(key) = named(&lower) {
        key
    } else if let Some(number) = lower
        .strip_prefix('f')
        .and_then(|rest| rest.parse::<u8>().ok())
    {
        if !(1..=20).contains(&number) {
            return Err(anyhow!("unknown key \"{last}\""));
        }
        Key::Function(number)
    } else {
        let mut chars = last.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) if c.is_ascii_graphic() => {
                if c.is_ascii_uppercase() {
                    modifiers.shift = true;
                }
                Key::Char(c.to_ascii_lowercase())
            }
            _ => return Err(anyhow!("unknown key \"{last}\"")),
        }
    };
    Ok(KeyChord { modifiers, key })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modifiers_named_keys_and_characters() {
        let chord = parse_chord("cmd+shift+t").unwrap();
        assert!(chord.modifiers.command && chord.modifiers.shift && !chord.modifiers.alt);
        assert_eq!(chord.key, Key::Char('t'));
        assert_eq!(
            parse_chord("Return").unwrap().key,
            Key::Named(Named::Return)
        );
        assert!(parse_chord("super+c").unwrap().modifiers.command);
        assert_eq!(parse_chord("F5").unwrap().key, Key::Function(5));
        assert_eq!(
            parse_chord("option+Left").unwrap().key,
            Key::Named(Named::Left)
        );
        assert_eq!(parse_chord("cmd++").unwrap().key, Key::Char('+'));
        assert_eq!(parse_chord("+").unwrap().key, Key::Char('+'));
        // An upper-case letter implies shift.
        let upper = parse_chord("A").unwrap();
        assert!(upper.modifiers.shift);
        assert_eq!(upper.key, Key::Char('a'));
    }

    #[test]
    fn rejects_unknown_names() {
        assert!(parse_chord("").is_err());
        assert!(parse_chord("hyper+a").is_err());
        assert!(parse_chord("cmd+banana").is_err());
        assert!(parse_chord("F30").is_err());
    }
}

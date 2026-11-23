use super::types::{
    AutoTitleContext, MAX_SESSION_TITLE_CHARS, TITLE_SOURCE_DEFAULT, TITLE_SOURCE_GENERATED,
    TITLE_SOURCE_MANUAL,
};
use crate::db::Database;
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};

/// Titles the app writes for a session the user has not named yet.
///
/// The renderer creates a session with its localized `chat.untitledTask` label
/// and also recognizes `nav.newChat`, so host-core has to recognize the same
/// values: it owns title eligibility and cannot read the renderer catalog when
/// it decides whether a title may still be replaced. Every entry is stored
/// lowercased and compared through `to_lowercase`, because both localized
/// keys the renderer writes — `chat.untitledTask` and `nav.newChat` — have
/// their own label per locale, and a non-ASCII uppercase letter (a future
/// "Ñö..." entry) would slip past ASCII-case-insensitive matching (#1755).
/// Keep this in sync with `LEGACY_DEFAULT_TITLES` in
/// `apps/desktop/src/lib/session-title-utils.ts`.
const PLACEHOLDER_TITLES: [&str; 19] = [
    "",
    "new task",
    "new chat",
    "新建任务",
    "新对话",
    "新建任務",
    "新對話",
    "새 작업",
    "새 채팅",
    "tarefa sem título",
    "nova conversa",
    "yeni görev",
    "yeni sohbet",
    "neue aufgabe",
    "nouvelle tâche",
    "nueva tarea",
    "neuer chat",
    "nuevo chat",
    "nouvelle discussion",
];

pub(super) fn is_default_title(title: &str) -> bool {
    let t = title.trim().to_lowercase();
    PLACEHOLDER_TITLES.iter().any(|p| *p == t)
}

// ---- UiMessage ⇄ transcript record mapping -----------------------------------

pub fn normalize_session_title(title: &str) -> Result<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(anyhow!("session title must not be empty"));
    }
    if title.chars().count() > MAX_SESSION_TITLE_CHARS {
        return Err(anyhow!(
            "session title must be at most {MAX_SESSION_TITLE_CHARS} characters"
        ));
    }
    Ok(title.to_string())
}

pub fn rename_session(db: &Database, id: &str, title: &str) -> Result<bool> {
    let title = normalize_session_title(title)?;
    let n = db
        .conn()
        .prepare_cached("UPDATE sessions SET title = ?1, title_source = ?2 WHERE id = ?3")?
        .execute(params![title, TITLE_SOURCE_MANUAL, id])?;
    Ok(n > 0)
}

/// Replace a still-untitled session's placeholder with text derived from its
/// first prompt.
///
/// This is the deterministic local fallback that keeps a new session readable
/// without any plugin. It deliberately keeps the `default` title source: the
/// derived text was not chosen by the user, so an installed title plugin may
/// still upgrade it through `set_automatic_session_title`. The write only
/// applies while host-core still sees a recognized placeholder, so a manual
/// rename, a plugin-generated title, or an earlier derivation all win.
pub fn derive_session_title(db: &Database, id: &str, title: &str) -> Result<bool> {
    let title = normalize_session_title(title)?;
    let current: Option<(String, String)> = db
        .conn()
        .query_row(
            "SELECT title, title_source FROM sessions
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((current_title, title_source)) = current else {
        return Ok(false);
    };
    if title_source != TITLE_SOURCE_DEFAULT || !is_default_title(&current_title) {
        return Ok(false);
    }
    let n = db
        .conn()
        .prepare_cached(
            "UPDATE sessions SET title = ?1
             WHERE id = ?2 AND title = ?3 AND title_source = ?4 AND deleted_at IS NULL",
        )?
        .execute(params![title, id, current_title, TITLE_SOURCE_DEFAULT])?;
    Ok(n > 0)
}

/// Return only the first-turn text needed to name an untouched session.
/// The dedicated plugin API must not become a transcript-reading shortcut.
pub fn auto_title_context(db: &Database, id: &str) -> Result<Option<AutoTitleContext>> {
    let row: Option<(String, String, Option<String>, Option<String>)> = db
        .conn()
        .query_row(
            "SELECT title, title_source, provider_id, model_id
             FROM sessions WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((title, title_source, provider_id, model_id)) = row else {
        return Ok(None);
    };
    if title_source != TITLE_SOURCE_DEFAULT {
        return Ok(None);
    }

    let first_user: Option<(i64, Option<String>, String)> = db
        .conn()
        .query_row(
            "SELECT seq, turn_id, text FROM messages
             WHERE session_id = ?1 AND role = 'user' AND text IS NOT NULL
             ORDER BY seq ASC LIMIT 1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((user_seq, turn_id, user_prompt)) = first_user else {
        return Ok(None);
    };
    if user_prompt.trim().is_empty() {
        return Ok(None);
    }
    let assistant_reply: Option<String> = db
        .conn()
        .query_row(
            "SELECT text FROM messages
             WHERE session_id = ?1 AND role = 'assistant' AND text IS NOT NULL AND seq > ?2
               AND (?3 IS NULL OR turn_id = ?3)
             ORDER BY seq ASC LIMIT 1",
            params![id, user_seq, turn_id],
            |row| row.get(0),
        )
        .optional()?;
    let user_prompt = truncate_title_context(&user_prompt, 1_000);
    let assistant_reply = assistant_reply
        .map(|reply| truncate_title_context(&reply, 500))
        .filter(|reply| !reply.trim().is_empty());
    Ok(Some(AutoTitleContext {
        session_id: id.to_string(),
        expected_title: title,
        user_prompt,
        assistant_reply,
        model_key: provider_id
            .zip(model_id)
            .map(|(provider, model)| format!("{provider}/{model}")),
    }))
}

fn truncate_title_context(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// Apply a plugin-generated title only if the exact default title read by the
/// plugin is still current and no manual or generated title has won the race.
pub fn set_automatic_session_title(
    db: &Database,
    id: &str,
    expected_title: &str,
    title: &str,
) -> Result<bool> {
    let title = normalize_session_title(title)?;
    let n = db
        .conn()
        .prepare_cached(
            "UPDATE sessions SET title = ?1, title_source = ?2
             WHERE id = ?3 AND title = ?4 AND title_source = ?5 AND deleted_at IS NULL",
        )?
        .execute(params![
            title,
            TITLE_SOURCE_GENERATED,
            id,
            expected_title,
            TITLE_SOURCE_DEFAULT
        ])?;
    Ok(n > 0)
}

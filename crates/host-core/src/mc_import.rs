//! mc-agent: import conversations from an installed PI-Desktop (MC-ADR-0009).
//!
//! PI-Desktop keeps the same storage as this host (an SQLite index beside
//! per-session JSONL transcripts), so its conversations are copied as they
//! are: canonical message blocks, thinking, tool calls and results, and
//! compaction checkpoints, which is what lets an imported conversation be
//! continued. The source is only ever read: its database is opened read-only
//! and its transcripts through the plain reader.

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use std::path::Path;

use crate::db::{ms_to_ts, Database};
use crate::sessions::{insert_index_row, record_index_text};
use crate::transcripts;

/// Imported sessions take this id prefix plus the source session id, so
/// importing the same conversation twice is a no-op.
pub const PI_DESKTOP_ID_PREFIX: &str = "import-pi-desktop-";
pub const PI_DESKTOP_SOURCE: &str = "pi-desktop";

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PiDesktopCandidate {
    pub external_id: String,
    pub title: String,
    pub project_path: Option<String>,
    pub model: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: i64,
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct ImportOutcome {
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
}

fn open_source(source_dir: &Path) -> Result<Connection> {
    let path = source_dir.join("pi.sqlite");
    if !path.is_file() {
        return Err(anyhow!(
            "NOT_FOUND: no PI-Desktop database at {}",
            path.display()
        ));
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    match Connection::open_with_flags(&path, flags) {
        Ok(conn) => Ok(conn),
        // A read-only connection cannot create the WAL index a closed
        // database may lack; read the main file as it stands instead.
        Err(_) => Connection::open_with_flags(
            format!("file:{}?immutable=1", path.display()),
            flags | OpenFlags::SQLITE_OPEN_URI,
        )
        .with_context(|| format!("open {}", path.display())),
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// The source's live (not deleted) conversations, newest first.
pub fn scan_pi_desktop(db: &Database, source_dir: &Path) -> Result<Vec<PiDesktopCandidate>> {
    if same_dir(source_dir, db.data_dir()) {
        return Err(anyhow!(
            "INVALID_PARAMS: the source is this installation's own data"
        ));
    }
    let conn = open_source(source_dir)?;
    let mut stmt = conn.prepare(
        "SELECT s.id, s.title, p.path, s.model_id, s.created_at, s.updated_at, s.last_seq
           FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.deleted_at IS NULL AND s.last_seq > 0
          ORDER BY s.updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PiDesktopCandidate {
            external_id: row.get(0)?,
            title: row.get(1)?,
            project_path: row
                .get::<_, Option<String>>(2)?
                .filter(|path| !path.trim().is_empty()),
            model: row.get(3)?,
            created_at: ms_to_ts(row.get(4)?),
            updated_at: ms_to_ts(row.get(5)?),
            message_count: row.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

struct SourceSession {
    title: String,
    project_path: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    mode: String,
    thinking_level: String,
    created_at: i64,
    updated_at: i64,
}

fn read_source_session(conn: &Connection, id: &str) -> Result<Option<SourceSession>> {
    conn.query_row(
        "SELECT s.title, p.path, s.provider_id, s.model_id, s.mode, s.thinking_level,
                s.created_at, s.updated_at
           FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.id = ?1 AND s.deleted_at IS NULL",
        params![id],
        |row| {
            Ok(SourceSession {
                title: row.get(0)?,
                project_path: row.get(1)?,
                provider_id: row.get(2)?,
                model_id: row.get(3)?,
                mode: row.get(4)?,
                thinking_level: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// Copies one conversation. Returns false when it was imported before.
fn import_one(
    db: &Database,
    conn: &Connection,
    source_dir: &Path,
    external_id: &str,
) -> Result<bool> {
    let session_id = format!("{PI_DESKTOP_ID_PREFIX}{external_id}");
    let exists: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
        params![session_id],
        |row| row.get(0),
    )?;
    if exists {
        return Ok(false);
    }
    let source = read_source_session(conn, external_id)?
        .ok_or_else(|| anyhow!("NOT_FOUND: session {external_id} is not in the source"))?;
    let read = transcripts::read_transcript_with_compactions(source_dir, external_id)?;
    if read.messages.is_empty() {
        return Err(anyhow!(
            "NOT_FOUND: session {external_id} has no transcript"
        ));
    }
    // A message id already in this database (an earlier fork or copy of the
    // same conversation) would collide with the global unique index.
    let collision: bool = {
        let mut stmt = db
            .conn()
            .prepare_cached("SELECT EXISTS(SELECT 1 FROM messages WHERE id = ?1)")?;
        let mut found = false;
        for record in &read.messages {
            if stmt.query_row(params![record.id], |row| row.get::<_, bool>(0))? {
                found = true;
                break;
            }
        }
        found
    };
    if collision {
        return Err(anyhow!(
            "CONFLICT: messages of {external_id} are already in this installation"
        ));
    }
    let created_at = ms_to_ts(source.created_at);
    transcripts::write_transcript_with_compactions(
        db.data_dir(),
        &session_id,
        &created_at,
        &read.messages,
        &read.compactions,
    )?;
    let indexed = (|| -> Result<()> {
        let conn = db.conn();
        let tx = conn.unchecked_transaction()?;
        let project_id = match source
            .project_path
            .as_deref()
            .filter(|path| !path.trim().is_empty())
        {
            Some(path) => Some(db.ensure_project(path, false)?),
            None => None,
        };
        // The model stays only when this installation has the same provider;
        // otherwise the conversation continues on the default model.
        let provider_known = match source.provider_id.as_deref() {
            Some(provider) => tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM providers WHERE id = ?1)",
                params![provider],
                |row| row.get::<_, bool>(0),
            )?,
            None => false,
        };
        let (provider_id, model_id) = if provider_known {
            (source.provider_id.clone(), source.model_id.clone())
        } else {
            (None, None)
        };
        tx.execute(
            "INSERT INTO sessions (
                id, title, project_id, provider_id, model_id, mode, thinking_level, source,
                last_seq, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                session_id,
                source.title,
                project_id,
                provider_id,
                model_id,
                crate::sessions::normalize_mode(Some(&source.mode)),
                normalized_thinking(&source.thinking_level),
                PI_DESKTOP_SOURCE,
                read.messages.len() as i64,
                source.created_at,
                source.updated_at.max(source.created_at),
            ],
        )?;
        for (seq, record) in read.messages.iter().enumerate() {
            let text = record_index_text(record);
            insert_index_row(&tx, &session_id, seq as i64, None, record, text.as_deref())?;
        }
        tx.commit()?;
        Ok(())
    })();
    if let Err(error) = indexed {
        transcripts::remove_session_files(db.data_dir(), &session_id);
        return Err(error);
    }
    Ok(true)
}

fn normalized_thinking(level: &str) -> &str {
    match level {
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "omit" => level,
        _ => "off",
    }
}

/// Copies the chosen conversations; each one succeeds or fails on its own.
pub fn import_pi_desktop(
    db: &Database,
    source_dir: &Path,
    external_ids: &[String],
) -> Result<ImportOutcome> {
    if same_dir(source_dir, db.data_dir()) {
        return Err(anyhow!(
            "INVALID_PARAMS: the source is this installation's own data"
        ));
    }
    let conn = open_source(source_dir)?;
    let mut outcome = ImportOutcome::default();
    for id in external_ids {
        match import_one(db, &conn, source_dir, id) {
            Ok(true) => outcome.imported += 1,
            Ok(false) => outcome.skipped += 1,
            Err(error) => {
                tracing::warn!(session = %id, %error, "pi-desktop import failed");
                outcome.failed += 1;
            }
        }
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{self, UiMessage};
    use serde_json::json;

    fn message(id: &str, role: &str, content: &str) -> UiMessage {
        serde_json::from_value(json!({
            "id": id,
            "role": role,
            "content": content,
            "createdAt": "2026-10-01T00:00:00.000Z",
        }))
        .unwrap()
    }

    fn seeded_source() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let source = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let summary: sessions::SessionSummary = serde_json::from_value(json!({
            "id": "src-1",
            "title": "Fix the parser",
            "projectPath": "/tmp/mc-import-project",
            "providerId": "elsewhere",
            "modelId": "some-model",
            "mode": "agent",
            "thinkingLevel": "high",
            "createdAt": "2026-10-01T00:00:00.000Z",
            "updatedAt": "2026-10-02T00:00:00.000Z",
        }))
        .unwrap();
        sessions::import_session(
            &source,
            &summary,
            &[
                message("m-1", "user", "please fix it"),
                message("m-2", "assistant", "fixed"),
            ],
        )
        .unwrap();
        drop(source);
        (dir, "src-1".to_string())
    }

    #[test]
    fn scans_and_copies_a_conversation_once() {
        let (source_dir, id) = seeded_source();
        let target_dir = tempfile::tempdir().unwrap();
        let target = Database::open(&target_dir.path().join("pi.sqlite")).unwrap();

        let found = scan_pi_desktop(&target, source_dir.path()).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].external_id, id);
        assert_eq!(found[0].title, "Fix the parser");
        assert_eq!(found[0].message_count, 2);
        assert!(found[0]
            .project_path
            .as_deref()
            .unwrap()
            .ends_with("mc-import-project"));

        let first = import_pi_desktop(&target, source_dir.path(), &[id.clone()]).unwrap();
        assert_eq!(
            first,
            ImportOutcome {
                imported: 1,
                skipped: 0,
                failed: 0
            }
        );
        let again = import_pi_desktop(&target, source_dir.path(), &[id.clone()]).unwrap();
        assert_eq!(
            again,
            ImportOutcome {
                imported: 0,
                skipped: 1,
                failed: 0
            }
        );

        let detail = sessions::get_session(&target, &format!("{PI_DESKTOP_ID_PREFIX}{id}"))
            .unwrap()
            .unwrap();
        assert_eq!(detail.summary.title, "Fix the parser");
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[1].content, "fixed");
        // The source's provider is unknown here, so the model is not kept.
        assert_eq!(detail.summary.provider_id, None);
        assert_eq!(detail.summary.thinking_level, "high");
        assert!(detail
            .summary
            .project_path
            .as_deref()
            .unwrap()
            .ends_with("mc-import-project"));
    }

    #[test]
    fn refuses_its_own_data_and_reports_missing_sessions() {
        let (source_dir, _) = seeded_source();
        let own = Database::open(&source_dir.path().join("pi.sqlite")).unwrap();
        assert!(scan_pi_desktop(&own, source_dir.path()).is_err());
        drop(own);

        let target_dir = tempfile::tempdir().unwrap();
        let target = Database::open(&target_dir.path().join("pi.sqlite")).unwrap();
        let outcome = import_pi_desktop(&target, source_dir.path(), &["nope".to_string()]).unwrap();
        assert_eq!(
            outcome,
            ImportOutcome {
                imported: 0,
                skipped: 0,
                failed: 1
            }
        );
    }
}

use super::types::SearchHit;
use crate::db::{ms_to_ts, Database};
use anyhow::Result;
use rusqlite::params;

pub fn search_messages(db: &Database, query: &str, limit: i64) -> Result<Vec<SearchHit>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 100);
    // trigram FTS needs >= 3 chars; shorter queries fall back to LIKE.
    if query.chars().count() >= 3 {
        let quoted = format!("\"{}\"", query.replace('"', "\"\""));
        // `snippet()` is an FTS5 auxiliary function, and the planner evaluates
        // it while it walks the FTS matches — that is, before the ORDER BY and
        // the LIMIT have reduced the set. It re-reads and re-tokenizes the
        // whole document on every call, so on a 40k-message corpus the 800
        // matches that produced 20 rows cost 5.24 of the statement's 6.00 ms.
        // The CTE moves the limit in front of it, leaving 20 calls.
        //
        // The inner subquery must repeat `MATCH ?1`: an FTS5 auxiliary function
        // reads the phrase list of the MATCH that positioned its cursor, so a
        // lookup by `rowid` alone has none and returns the head of the document
        // instead of the window around the hit. The two forms were compared row
        // for row: with the repeated MATCH, id, order and snippet
        // text are identical; without it, 0 of 20 snippets match.
        let mut stmt = db.conn().prepare_cached(
            "WITH hits AS (
               SELECT m.id, m.mid, m.session_id, s.title, m.role, m.created_at
               FROM messages_fts
               JOIN messages m ON m.mid = messages_fts.rowid
               JOIN sessions s ON s.id = m.session_id
               WHERE messages_fts MATCH ?1
               ORDER BY m.created_at DESC LIMIT ?2
             )
             SELECT hits.id, hits.session_id, hits.title, hits.role,
                    hits.created_at,
                    (SELECT snippet(messages_fts, 0, '', '', '…', 16)
                     FROM messages_fts
                     WHERE messages_fts MATCH ?1
                       AND messages_fts.rowid = hits.mid)
             FROM hits",
        )?;
        let rows = stmt.query_map(params![quoted, limit], |row| {
            Ok(SearchHit {
                message_id: row.get(0)?,
                session_id: row.get(1)?,
                session_title: row.get(2)?,
                role: row.get(3)?,
                created_at: ms_to_ts(row.get(4)?),
                snippet: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    } else {
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let mut stmt = db.conn().prepare_cached(
            "SELECT m.id, m.session_id, s.title, m.role, m.created_at,
                    substr(m.text, 1, 160)
             FROM messages m
             JOIN sessions s ON s.id = m.session_id
             WHERE m.text LIKE '%' || ?1 || '%' ESCAPE '\\'
             ORDER BY m.created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![escaped, limit], |row| {
            Ok(SearchHit {
                message_id: row.get(0)?,
                session_id: row.get(1)?,
                session_title: row.get(2)?,
                role: row.get(3)?,
                created_at: ms_to_ts(row.get(4)?),
                snippet: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

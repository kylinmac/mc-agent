//! mc-agent: token usage summary by model, project, day and conversation
//! (MC-ADR-0011).
//!
//! Every ended turn records its provider, model, session and usage (input,
//! output, cache read/write, reasoning). This folds the turns of a time range
//! into the views the usage page shows. Totals follow upstream's history:
//! input + output + cache read + cache write (reasoning is part of output on
//! the providers that report it separately, so it is shown but not added).

use anyhow::Result;
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

use crate::db::Database;

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageCounts {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub reasoning_tokens: i64,
    pub total_tokens: i64,
    pub turns: i64,
}

impl UsageCounts {
    fn add(&mut self, other: &UsageCounts) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_write_tokens += other.cache_write_tokens;
        self.reasoning_tokens += other.reasoning_tokens;
        self.total_tokens += other.total_tokens;
        self.turns += other.turns;
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub provider_id: Option<String>,
    pub provider_name: Option<String>,
    pub model_id: Option<String>,
    #[serde(flatten)]
    pub counts: UsageCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    pub path: Option<String>,
    #[serde(flatten)]
    pub counts: UsageCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    pub day: String,
    #[serde(flatten)]
    pub counts: UsageCounts,
}

/// One model's usage on one day, for the per-model daily chart.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayModelUsage {
    pub day: String,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    #[serde(flatten)]
    pub counts: UsageCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub session_id: String,
    pub title: String,
    pub project_path: Option<String>,
    #[serde(flatten)]
    pub counts: UsageCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub from_ms: i64,
    pub to_ms: i64,
    pub totals: UsageCounts,
    pub by_model: Vec<ModelUsage>,
    pub by_project: Vec<ProjectUsage>,
    pub by_day: Vec<DayUsage>,
    pub by_day_model: Vec<DayModelUsage>,
    pub top_sessions: Vec<SessionUsage>,
}

const TOP_SESSIONS: usize = 15;

fn field(usage: &Option<Value>, key: &str) -> i64 {
    usage
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

fn sorted<T>(mut items: Vec<T>, total: impl Fn(&T) -> i64) -> Vec<T> {
    items.sort_by_key(|item| std::cmp::Reverse(total(item)));
    items
}

/// The usage of every turn that ended in `[from_ms, to_ms]`, whatever its
/// status: a stopped or failed turn still spent what it reported.
pub fn summary(db: &Database, from_ms: i64, to_ms: i64) -> Result<UsageSummary> {
    let conn = db.conn();
    let provider_names: HashMap<String, String> = {
        let mut stmt = conn.prepare("SELECT id, name FROM providers")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut stmt = conn.prepare(
        "SELECT t.ended_at, t.provider_id, t.model_id, t.input_tokens, t.output_tokens, t.usage_json,
                t.session_id, s.title, p.path
           FROM turns t
           JOIN sessions s ON s.id = t.session_id
           LEFT JOIN projects p ON p.id = s.project_id
          WHERE t.ended_at IS NOT NULL AND t.ended_at >= ?1 AND t.ended_at <= ?2",
    )?;
    let rows = stmt.query_map(params![from_ms, to_ms], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, Option<String>>(8)?,
        ))
    })?;

    let mut totals = UsageCounts::default();
    let mut models: HashMap<(Option<String>, Option<String>), UsageCounts> = HashMap::new();
    let mut projects: HashMap<Option<String>, UsageCounts> = HashMap::new();
    let mut days: BTreeMap<String, UsageCounts> = BTreeMap::new();
    #[allow(clippy::type_complexity)]
    let mut day_models: BTreeMap<(String, Option<String>, Option<String>), UsageCounts> =
        BTreeMap::new();
    let mut sessions: HashMap<String, (String, Option<String>, UsageCounts)> = HashMap::new();

    for row in rows {
        let (ended_at, provider_id, model_id, input, output, usage_json, session_id, title, path) =
            row?;
        let usage = usage_json
            .as_deref()
            .and_then(|text| serde_json::from_str::<Value>(text).ok());
        let cache_read = field(&usage, "cacheReadTokens");
        let cache_write = field(&usage, "cacheWriteTokens");
        let counts = UsageCounts {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_write,
            reasoning_tokens: field(&usage, "reasoningTokens"),
            total_tokens: input + output + cache_read + cache_write,
            turns: 1,
        };
        if counts.total_tokens == 0 {
            continue;
        }
        totals.add(&counts);
        models
            .entry((provider_id.clone(), model_id.clone()))
            .or_default()
            .add(&counts);
        projects.entry(path.clone()).or_default().add(&counts);
        if let Some(day) = chrono::DateTime::from_timestamp_millis(ended_at).map(|dt| {
            dt.with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        }) {
            day_models
                .entry((day.clone(), provider_id, model_id))
                .or_default()
                .add(&counts);
            days.entry(day).or_default().add(&counts);
        }
        sessions
            .entry(session_id)
            .or_insert_with(|| (title, path, UsageCounts::default()))
            .2
            .add(&counts);
    }

    let by_model = sorted(
        models
            .into_iter()
            .map(|((provider_id, model_id), counts)| ModelUsage {
                provider_name: provider_id
                    .as_ref()
                    .and_then(|id| provider_names.get(id).cloned()),
                provider_id,
                model_id,
                counts,
            })
            .collect(),
        |item: &ModelUsage| item.counts.total_tokens,
    );
    let by_project = sorted(
        projects
            .into_iter()
            .map(|(path, counts)| ProjectUsage { path, counts })
            .collect(),
        |item: &ProjectUsage| item.counts.total_tokens,
    );
    let by_day_model = day_models
        .into_iter()
        .map(|((day, provider_id, model_id), counts)| DayModelUsage {
            day,
            provider_id,
            model_id,
            counts,
        })
        .collect();
    let by_day = days
        .into_iter()
        .map(|(day, counts)| DayUsage { day, counts })
        .collect();
    let mut top_sessions = sorted(
        sessions
            .into_iter()
            .map(|(session_id, (title, project_path, counts))| SessionUsage {
                session_id,
                title,
                project_path,
                counts,
            })
            .collect(),
        |item: &SessionUsage| item.counts.total_tokens,
    );
    top_sessions.truncate(TOP_SESSIONS);

    Ok(UsageSummary {
        from_ms,
        to_ms,
        totals,
        by_model,
        by_project,
        by_day,
        by_day_model,
        top_sessions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;
    use serde_json::json;

    #[test]
    fn folds_turns_by_model_project_day_and_session() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let a = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let b = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let mut end = |session: &str, model: &str, usage: Value| {
            let turn = sessions::begin_turn(&db, session, Some("p1"), Some(model)).unwrap();
            sessions::end_turn_settling(&db, &turn, "completed", None, Some(&usage), false, false)
                .unwrap();
        };
        end(
            &a.id,
            "claude-opus-5",
            json!({ "inputTokens": 100, "outputTokens": 50, "cacheReadTokens": 30 }),
        );
        end(
            &a.id,
            "claude-opus-5",
            json!({ "inputTokens": 10, "outputTokens": 5 }),
        );
        end(
            &b.id,
            "grok-4.7",
            json!({ "inputTokens": 20, "outputTokens": 20, "reasoningTokens": 7 }),
        );

        let now = crate::db::now_ms();
        let folded = super::summary(&db, now - 60_000, now + 60_000).unwrap();
        assert_eq!(folded.totals.total_tokens, 100 + 50 + 30 + 10 + 5 + 40);
        assert_eq!(folded.totals.turns, 3);
        assert_eq!(folded.totals.reasoning_tokens, 7);
        assert_eq!(folded.by_model.len(), 2);
        assert_eq!(
            folded.by_model[0].model_id.as_deref(),
            Some("claude-opus-5")
        );
        assert_eq!(folded.by_model[0].counts.turns, 2);
        assert_eq!(folded.by_model[0].counts.cache_read_tokens, 30);
        assert_eq!(folded.by_day.len(), 1);
        assert_eq!(folded.by_day_model.len(), 2);
        assert_eq!(
            folded
                .by_day_model
                .iter()
                .map(|row| row.counts.total_tokens)
                .sum::<i64>(),
            folded.totals.total_tokens
        );
        assert_eq!(folded.top_sessions[0].session_id, a.id);
        assert_eq!(folded.by_project.len(), 1);
        assert_eq!(folded.by_project[0].path, None);

        let empty = super::summary(&db, 0, 1).unwrap();
        assert_eq!(empty.totals, UsageCounts::default());
    }
}

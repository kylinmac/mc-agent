use crate::db::Database;
use anyhow::Result;
use rusqlite::params;
use serde_json::{json, Value};

fn normalize_usage_bucket(bucket: &str) -> &'static str {
    match bucket {
        "week" => "week",
        "month" => "month",
        _ => "day",
    }
}

fn local_from_ms(ms: i64) -> Option<chrono::DateTime<chrono::Local>> {
    chrono::DateTime::from_timestamp_millis(ms).map(|dt| dt.with_timezone(&chrono::Local))
}

fn usage_bucket_key(dt: &chrono::DateTime<chrono::Local>, bucket: &str) -> String {
    match bucket {
        "month" => dt.format("%Y-%m").to_string(),
        "week" => dt.format("%G-W%V").to_string(),
        _ => dt.format("%Y-%m-%d").to_string(),
    }
}

fn default_history_start(
    end: chrono::DateTime<chrono::Local>,
    bucket: &str,
) -> chrono::DateTime<chrono::Local> {
    match bucket {
        "month" => end - chrono::Duration::days(365 * 2),
        "week" => end - chrono::Duration::weeks(52),
        _ => end - chrono::Duration::weeks(53),
    }
}

fn resolve_history_range(
    start_date: Option<i64>,
    end_date: Option<i64>,
    bucket: &str,
) -> (i64, i64) {
    let now = chrono::Local::now();
    let end = end_date
        .filter(|v| *v > 0)
        .and_then(local_from_ms)
        .unwrap_or(now);
    let start = start_date
        .filter(|v| *v > 0)
        .and_then(local_from_ms)
        .unwrap_or_else(|| default_history_start(end, bucket));
    if start <= end {
        (start.timestamp_millis(), end.timestamp_millis())
    } else {
        (end.timestamp_millis(), start.timestamp_millis())
    }
}

fn naive_local_midnight(date: chrono::NaiveDate) -> Option<chrono::DateTime<chrono::Local>> {
    use chrono::TimeZone;
    let naive = date.and_hms_opt(0, 0, 0)?;
    match chrono::Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt),
        chrono::LocalResult::Ambiguous(dt, _) => Some(dt),
        chrono::LocalResult::None => None,
    }
}

fn filled_history_keys(start_ms: i64, end_ms: i64, bucket: &str) -> Vec<(String, i64)> {
    use chrono::{Datelike, TimeZone};
    let start = local_from_ms(start_ms).unwrap_or_else(chrono::Local::now);
    let end = local_from_ms(end_ms).unwrap_or_else(chrono::Local::now);
    let mut keys = Vec::new();
    match bucket {
        "month" => {
            let mut year = start.year();
            let mut month = start.month();
            let end_y = end.year();
            let end_m = end.month();
            loop {
                if let chrono::LocalResult::Single(dt) | chrono::LocalResult::Ambiguous(dt, _) =
                    chrono::Local.with_ymd_and_hms(year, month, 1, 0, 0, 0)
                {
                    keys.push((dt.format("%Y-%m").to_string(), dt.timestamp_millis()));
                }
                if year > end_y || (year == end_y && month >= end_m) {
                    break;
                }
                month += 1;
                if month == 13 {
                    month = 1;
                    year += 1;
                }
            }
        }
        "week" => {
            let weekday = start.weekday().num_days_from_monday() as i64;
            let mut cursor = start.date_naive() - chrono::Duration::days(weekday);
            let end_date = end.date_naive();
            while cursor <= end_date {
                if let Some(dt) = naive_local_midnight(cursor) {
                    keys.push((dt.format("%G-W%V").to_string(), dt.timestamp_millis()));
                }
                cursor += chrono::Duration::days(7);
            }
        }
        _ => {
            let mut cursor = start.date_naive();
            let end_date = end.date_naive();
            while cursor <= end_date {
                if let Some(dt) = naive_local_midnight(cursor) {
                    keys.push((dt.format("%Y-%m-%d").to_string(), dt.timestamp_millis()));
                }
                cursor += chrono::Duration::days(1);
            }
        }
    }
    keys
}

#[derive(Default, Clone, Copy)]
struct UsageBucketAcc {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    reasoning: i64,
    turns: i64,
    timestamp: i64,
}

impl UsageBucketAcc {
    fn add(
        &mut self,
        input: i64,
        output: i64,
        cache_read: i64,
        cache_write: i64,
        reasoning: i64,
        ts: i64,
    ) {
        if self.turns == 0 {
            self.timestamp = ts;
        }
        self.input += input;
        self.output += output;
        self.cache_read += cache_read;
        self.cache_write += cache_write;
        self.reasoning += reasoning;
        self.turns += 1;
    }

    fn total_tokens(&self) -> i64 {
        self.input + self.output + self.cache_read + self.cache_write
    }

    fn to_json(self, date: &str) -> Value {
        json!({
            "date": date,
            "timestamp": self.timestamp,
            "inputTokens": self.input,
            "outputTokens": self.output,
            "totalTokens": self.total_tokens(),
            "cacheReadTokens": self.cache_read,
            "cacheWriteTokens": self.cache_write,
            "reasoningTokens": self.reasoning,
            "turnCount": self.turns,
        })
    }
}

pub fn get_token_usage_history(
    db: &Database,
    start_date: Option<i64>,
    end_date: Option<i64>,
    bucket: &str,
) -> Result<Value> {
    let bucket = normalize_usage_bucket(bucket);
    let (range_start, range_end) = resolve_history_range(start_date, end_date, bucket);
    let mut stmt = db.conn().prepare_cached(
        "SELECT ended_at, input_tokens, output_tokens, usage_json
         FROM turns
         WHERE status = 'completed' AND ended_at IS NOT NULL AND ended_at >= ?1 AND ended_at <= ?2
         ORDER BY ended_at ASC",
    )?;

    let rows = stmt.query_map(params![range_start, range_end], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;

    use std::collections::BTreeMap;
    let mut bucket_map: BTreeMap<String, UsageBucketAcc> = BTreeMap::new();
    let mut total_input = 0i64;
    let mut total_output = 0i64;
    let mut total_turns = 0i64;
    let mut total_cache_read = 0i64;
    let mut total_cache_write = 0i64;
    let mut total_reasoning = 0i64;

    for row in rows {
        let (ended_at, input_tokens, output_tokens, usage_json) = row?;
        let Some(dt) = local_from_ms(ended_at) else {
            continue;
        };
        total_turns += 1;
        total_input += input_tokens;
        total_output += output_tokens;

        let parsed_usage = usage_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok());
        let cache_read = parsed_usage
            .as_ref()
            .and_then(|u| u.get("cacheReadTokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let cache_write = parsed_usage
            .as_ref()
            .and_then(|u| u.get("cacheWriteTokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let reasoning = parsed_usage
            .as_ref()
            .and_then(|u| u.get("reasoningTokens"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        total_cache_read += cache_read;
        total_cache_write += cache_write;
        total_reasoning += reasoning;

        let key = usage_bucket_key(&dt, bucket);
        bucket_map.entry(key).or_default().add(
            input_tokens,
            output_tokens,
            cache_read,
            cache_write,
            reasoning,
            ended_at,
        );
    }

    let items: Vec<Value> = filled_history_keys(range_start, range_end, bucket)
        .into_iter()
        .map(|(date, timestamp)| {
            let mut acc = bucket_map.remove(&date).unwrap_or_default();
            if acc.turns == 0 {
                acc.timestamp = timestamp;
            }
            acc.to_json(&date)
        })
        .collect();

    Ok(json!({
        "bucket": bucket,
        "rangeStart": range_start,
        "rangeEnd": range_end,
        "items": items,
        "totals": {
            "inputTokens": total_input,
            "outputTokens": total_output,
            "totalTokens": total_input + total_output + total_cache_read + total_cache_write,
            "cacheReadTokens": total_cache_read,
            "cacheWriteTokens": total_cache_write,
            "reasoningTokens": total_reasoning,
            "turnCount": total_turns,
        }
    }))
}

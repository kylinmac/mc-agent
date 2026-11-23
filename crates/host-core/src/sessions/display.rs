use super::message_codec::record_to_ui;
use super::types::UiMessage;
use crate::transcripts::MessageRecord;
use serde_json::Value;

pub(super) const DISPLAY_TRUNCATION_MARKER: &str =
    "\n\n[truncated for display; the full content remains in the transcript]";

fn truncate_display_text(text: String, limit: usize) -> (String, bool) {
    if text.chars().count() <= limit {
        return (text, false);
    }
    let marker_len = DISPLAY_TRUNCATION_MARKER.chars().count();
    if limit <= marker_len {
        return (
            DISPLAY_TRUNCATION_MARKER.chars().take(limit).collect(),
            true,
        );
    }
    let head = limit - marker_len;
    (
        format!(
            "{}{}",
            text.chars().take(head).collect::<String>(),
            DISPLAY_TRUNCATION_MARKER
        ),
        true,
    )
}

fn preview_value(value: Value, limit: usize) -> Value {
    fn walk(value: Value, budget: &mut usize) -> Value {
        if *budget == 0 {
            return Value::String("[truncated for display]".into());
        }
        match value {
            Value::String(text) => {
                let (clipped, _) = truncate_display_text(text, *budget);
                *budget = (*budget).saturating_sub(clipped.chars().count());
                Value::String(clipped)
            }
            Value::Array(items) => {
                let mut output = Vec::with_capacity(items.len().min(32));
                for item in items {
                    if *budget == 0 || output.len() >= 256 {
                        output.push(Value::String("[truncated for display]".into()));
                        break;
                    }
                    output.push(walk(item, budget));
                }
                Value::Array(output)
            }
            Value::Object(object) => {
                let mut output = serde_json::Map::new();
                for (key, item) in object {
                    if *budget == 0 || output.len() >= 256 {
                        output.insert("_truncated".into(), Value::Bool(true));
                        break;
                    }
                    output.insert(key, walk(item, budget));
                }
                Value::Object(output)
            }
            other => other,
        }
    }

    let mut budget = limit.max(1);
    walk(value, &mut budget)
}

fn cap_record_block_value(value: &mut Value, budget: &mut usize) {
    let original = std::mem::take(value);
    *value = match original {
        Value::String(text) if *budget > 0 => {
            let (clipped, _) = truncate_display_text(text, *budget);
            *budget = budget.saturating_sub(clipped.chars().count());
            Value::String(clipped)
        }
        Value::String(_) => Value::String(String::new()),
        other => other,
    };
}

fn cap_record_blocks_for_display(record: &mut MessageRecord, limit: usize) {
    let Some(blocks) = record.blocks.as_array_mut() else {
        return;
    };
    let mut text_budget = limit.max(1);
    let mut thinking_budget = limit.max(1);
    for block in blocks {
        let Some(object) = block.as_object_mut() else {
            continue;
        };
        match object.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = object.get_mut("text") {
                    cap_record_block_value(text, &mut text_budget);
                }
            }
            Some("thinking") => {
                if let Some(text) = object.get_mut("text") {
                    cap_record_block_value(text, &mut thinking_budget);
                }
            }
            Some("tool_call") => {
                for key in ["args", "result"] {
                    if let Some(value) = object.get_mut(key) {
                        *value = preview_value(std::mem::take(value), limit);
                    }
                }
                if let Some(text) = object.get_mut("text") {
                    cap_record_block_value(text, &mut text_budget);
                }
            }
            _ => {}
        }
    }
}

pub(super) fn record_to_ui_for_display(mut record: MessageRecord, limit: usize) -> UiMessage {
    // Bound the canonical block values before record_to_ui concatenates text
    // blocks or clones tool payloads. This keeps a 50 MB selected line from
    // producing another 50 MB temporary UI string on the host.
    cap_record_blocks_for_display(&mut record, limit);
    let mut message = record_to_ui(record);
    let (content, _) = truncate_display_text(message.content, limit);
    message.content = content;
    if let Some(thinking) = message.thinking.take() {
        let (thinking, _) = truncate_display_text(thinking, limit);
        message.thinking = Some(thinking);
    }
    if let Some(args) = message.tool_args.take() {
        message.tool_args = Some(preview_value(args, limit));
    }
    if let Some(result) = message.tool_result.take() {
        message.tool_result = Some(preview_value(result, limit));
    }
    if let Some(error) = message.error.take() {
        message.error = Some(preview_value(error, limit));
    }
    message
}

use std::collections::HashSet;

use anyhow::Result;
use serde_json::Value;

use super::{record_to_ui, record_to_ui_for_display, UiMessage, DISPLAY_TRUNCATION_MARKER};
use crate::{db::Database, transcripts};

// Match the maximum physical page size, even when a roster names more tasks.
const MAX_PARENT_REFERENCES: usize = 1000;

fn tool_name(message: &UiMessage) -> String {
    message
        .tool_name
        .as_deref()
        .unwrap_or_default()
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase()
}

fn payload(message: &UiMessage) -> Option<&Value> {
    let result = message.tool_result.as_ref()?;
    Some(
        result
            .get("details")
            .filter(|value| !value.is_null())
            .unwrap_or(result),
    )
}

fn reference_id(id: &&str) -> bool {
    !id.trim().is_empty()
        && !id.ends_with(DISPLAY_TRUNCATION_MARKER)
        && !DISPLAY_TRUNCATION_MARKER.starts_with(*id)
        && *id != "[truncated for display]"
}

fn missing_references(messages: &[UiMessage]) -> (HashSet<String>, HashSet<String>) {
    let tasks: Vec<_> = messages
        .iter()
        .filter(|message| message.role == "tool")
        .filter(|message| matches!(tool_name(message).as_str(), "task" | "subagent"))
        .collect();
    let loaded_calls: HashSet<_> = tasks
        .iter()
        .filter_map(|message| message.tool_call_id.as_deref())
        .collect();
    let loaded_delegations: HashSet<_> = tasks
        .iter()
        .filter_map(|message| {
            payload(message)
                .and_then(|result| result.get("delegationId"))
                .and_then(Value::as_str)
        })
        .collect();
    let calls: HashSet<String> = messages
        .iter()
        .filter_map(|message| message.parent_tool_call_id.as_deref())
        .filter(reference_id)
        .filter(|id| !loaded_calls.contains(id))
        .take(MAX_PARENT_REFERENCES)
        .map(str::to_owned)
        .collect();
    let mut delegations = HashSet::new();
    'rosters: for message in messages.iter().filter(|message| message.role == "tool") {
        if !matches!(
            tool_name(message).as_str(),
            "tasklist" | "taskwait" | "taskstop"
        ) {
            continue;
        }
        let Some(result) = payload(message) else {
            continue;
        };
        for key in ["delegations", "stopped"] {
            for entry in result
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if calls.len() + delegations.len() >= MAX_PARENT_REFERENCES {
                    break 'rosters;
                }
                if let Some(id) = entry
                    .get("delegationId")
                    .and_then(Value::as_str)
                    .filter(reference_id)
                    .filter(|id| !loaded_delegations.contains(id))
                {
                    delegations.insert(id.to_owned());
                }
            }
        }
    }
    (calls, delegations)
}

pub(super) fn read(
    db: &Database,
    session_id: &str,
    messages: &[UiMessage],
    content_limit: Option<usize>,
) -> Result<Vec<UiMessage>> {
    let (calls, delegations) = missing_references(messages);
    if calls.is_empty() && delegations.is_empty() {
        return Ok(Vec::new());
    }
    let records = transcripts::layout::with_layout_recovery(db.data_dir(), session_id, |layout| {
        transcripts::read_delegation_parents(
            db.data_dir(),
            session_id,
            layout,
            &calls,
            &delegations,
        )
    })?;
    Ok(records
        .into_iter()
        .map(|record| match content_limit {
            Some(limit) => record_to_ui_for_display(record, limit),
            None => record_to_ui(record),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(extra: Value) -> UiMessage {
        let mut value = json!({ "id": "m", "role": "tool", "content": "", "createdAt": "now" });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn references_are_bounded_deduplicated_and_children_take_priority() {
        let roster = message(
            json!({ "toolName": "functions.TaskList", "toolResult": { "details": {
            "delegations": (0..2000).map(|n| json!({ "delegationId": format!("delegate-{n}") })).collect::<Vec<_>>()
        } } }),
        );
        let child = message(json!({ "role": "assistant", "parentToolCallId": "child-call" }));
        let (calls, delegations) =
            missing_references(&[roster.clone(), roster, child.clone(), child]);
        assert_eq!(calls.len(), 1);
        assert!(calls.contains("child-call"));
        assert_eq!(calls.len() + delegations.len(), MAX_PARENT_REFERENCES);
        assert!(delegations.contains("delegate-0"));
        assert!(!delegations.contains("delegate-999"));
    }

    #[test]
    fn loaded_parents_and_invalid_rosters_do_not_request_a_scan() {
        let task = message(
            json!({ "toolName": "Subagent", "toolCallId": "call", "toolResult": { "delegationId": "delegate" } }),
        );
        let child = message(json!({ "parentToolCallId": "call" }));
        let roster = message(json!({ "toolName": "TaskStop", "toolResult": { "stopped": [
            { "delegationId": "delegate" }, { "delegationId": "" }, { "delegationId": 1 },
            { "delegationId": "[truncated for display]" }, { "delegationId": "\n\n[tru" }, "malformed"
        ] } }));
        let ignored = message(
            json!({ "toolName": "Bash", "toolResult": { "delegations": [{ "delegationId": "other" }] } }),
        );
        let (calls, delegations) = missing_references(&[task, child, roster, ignored]);
        assert!(calls.is_empty());
        assert!(delegations.is_empty());
    }

    #[test]
    fn opaque_escaped_references_survive_but_display_markers_do_not() {
        let call_id = "call\n\"with\\escapes";
        let delegation_id = "delegate\n\"with\\escapes";
        let child = message(json!({ "parentToolCallId": call_id }));
        let roster = message(
            json!({ "toolName": "TaskWait", "toolResult": { "delegations": [
            { "delegationId": delegation_id },
            { "delegationId": "[truncated-but-valid-id" },
            { "delegationId": "[truncated for display]" },
            { "delegationId": "\n\n[tru" },
            { "delegationId": format!("head{}", DISPLAY_TRUNCATION_MARKER) }
        ] } }),
        );
        let (calls, delegations) = missing_references(&[child, roster]);
        assert_eq!(calls, HashSet::from([call_id.to_owned()]));
        assert_eq!(
            delegations,
            HashSet::from([delegation_id.to_owned(), "[truncated-but-valid-id".into()])
        );
    }
}

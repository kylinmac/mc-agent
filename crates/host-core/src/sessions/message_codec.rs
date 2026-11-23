use super::types::{MessageAttachment, MessageUsage, UiMessage};
use crate::transcripts::MessageRecord;
use serde_json::{json, Value};

/// UiMessage → persisted transcript record, plus the extracted plain text for
/// the search index row (None for tool rows, matching the FTS triggers).
pub(crate) fn ui_to_record(message: &UiMessage) -> (MessageRecord, Option<String>) {
    let mut meta_obj = serde_json::Map::new();
    if let Some(system) = &message.model_system {
        meta_obj.insert("modelSystem".into(), system.clone());
    }
    if let Some(command) = &message.command {
        meta_obj.insert("command".into(), json!(command));
    }
    if let Some(mentions) = &message.skill_mentions {
        meta_obj.insert("skillMentions".into(), json!(mentions));
    }
    if let Some(origin) = &message.session_message {
        meta_obj.insert("sessionMessage".into(), origin.clone());
    }
    if let Some(origin) = &message.voice_origin {
        meta_obj.insert("voiceOrigin".into(), origin.clone());
    }
    if let Some(steering) = message.steering {
        meta_obj.insert("steering".into(), json!(steering));
    }
    if let Some(status) = &message.status {
        meta_obj.insert("status".into(), json!(status));
    }
    if let Some(model_id) = &message.model_id {
        meta_obj.insert("modelId".into(), json!(model_id));
    }
    if let Some(provider_id) = &message.provider_id {
        meta_obj.insert("providerId".into(), json!(provider_id));
    }
    if let Some(usage) = &message.usage {
        meta_obj.insert("usage".into(), json!(usage));
    }
    if let Some(duration) = message.response_duration_ms {
        meta_obj.insert("responseDurationMs".into(), json!(duration));
    }
    if let Some(tokens) = message.response_output_tokens {
        meta_obj.insert("responseOutputTokens".into(), json!(tokens));
    }
    if let Some(stop) = &message.stop_reason {
        meta_obj.insert("stopReason".into(), stop.clone());
    }
    if let Some(error) = &message.error {
        meta_obj.insert("error".into(), error.clone());
    }
    if let Some(root_id) = &message.revision_root_id {
        meta_obj.insert("revisionRootId".into(), json!(root_id));
    }
    if let Some(count) = message.revision_count {
        meta_obj.insert("revisionCount".into(), json!(count));
    }
    if let Some(active) = message.active_revision {
        meta_obj.insert("activeRevision".into(), json!(active));
    }
    if let Some(parent) = &message.parent_tool_call_id {
        meta_obj.insert("parentToolCallId".into(), json!(parent));
    }
    if let Some(parent) = &message.nested_parent_tool_call_id {
        meta_obj.insert("nestedParentToolCallId".into(), json!(parent));
    }
    if let Some(agent) = &message.agent_name {
        meta_obj.insert("agentName".into(), json!(agent));
    }
    let meta = if meta_obj.is_empty() {
        None
    } else {
        Some(Value::Object(meta_obj))
    };

    let mut blocks = Vec::with_capacity(2 + message.attachments.as_ref().map_or(0, Vec::len));
    if let Some(thinking) = &message.thinking {
        blocks.push(json!({ "type": "thinking", "text": thinking }));
    }
    if let Some(hosted_search) = &message.hosted_search {
        let mut block = serde_json::Map::new();
        block.insert("type".into(), json!("hostedSearch"));
        if let Value::Object(fields) = hosted_search {
            for (key, value) in fields {
                if key != "type" {
                    block.insert(key.clone(), value.clone());
                }
            }
        }
        blocks.push(Value::Object(block));
    }
    let text = if message.role == "tool" {
        let mut block = serde_json::Map::new();
        block.insert("type".into(), json!("tool_call"));
        if let Some(v) = &message.tool_call_id {
            block.insert("callId".into(), json!(v));
        }
        if let Some(v) = &message.tool_name {
            block.insert("name".into(), json!(v));
        }
        if let Some(v) = &message.tool_args {
            block.insert("args".into(), v.clone());
        }
        if let Some(v) = &message.tool_result {
            block.insert("result".into(), v.clone());
        }
        if let Some(v) = &message.tool_completed_at {
            block.insert("completedAt".into(), json!(v));
        }
        if let Some(v) = message.tool_duration_ms {
            block.insert("durationMs".into(), json!(v));
        }
        if let Some(v) = &message.tool_status {
            block.insert("status".into(), json!(v));
        }
        if message.is_error.unwrap_or(false) {
            block.insert("isError".into(), json!(true));
        }
        if !message.content.is_empty() {
            block.insert("text".into(), json!(message.content));
        }
        blocks.push(Value::Object(block));
        None
    } else {
        blocks.push(json!({ "type": "text", "text": message.content }));
        if let Some(attachments) = &message.attachments {
            for attachment in attachments {
                let mut block = serde_json::Map::new();
                block.insert("type".into(), json!("attachment"));
                block.insert("kind".into(), json!(attachment.kind));
                block.insert("name".into(), json!(attachment.name));
                block.insert("ref".into(), json!(attachment.reference));
                if let Some(mime_type) = &attachment.mime_type {
                    block.insert("mimeType".into(), json!(mime_type));
                }
                if let Some(size) = attachment.size {
                    block.insert("size".into(), json!(size));
                }
                if let Some(text) = &attachment.text {
                    block.insert("text".into(), json!(text));
                }
                if let Some(inline_path) = &attachment.inline_path {
                    block.insert("inlinePath".into(), json!(inline_path));
                }
                blocks.push(Value::Object(block));
            }
        }
        Some(message.content.clone())
    };

    (
        MessageRecord {
            id: message.id.clone(),
            role: message.role.clone(),
            tool_name: message.tool_name.clone(),
            is_error: message.is_error.unwrap_or(false),
            blocks: Value::Array(blocks),
            meta,
            created_at: message.created_at.clone(),
        },
        text,
    )
}

pub(crate) fn record_to_ui(record: MessageRecord) -> UiMessage {
    let blocks = match record.blocks {
        Value::Array(items) => items,
        _ => Vec::new(),
    };
    let meta = record.meta.unwrap_or(Value::Null);
    let model_system = meta.get("modelSystem").cloned();
    let command = meta
        .get("command")
        .and_then(Value::as_str)
        .map(str::to_string);
    let skill_mentions = meta
        .get("skillMentions")
        .and_then(|value| serde_json::from_value(value.clone()).ok());
    let session_message = meta.get("sessionMessage").cloned();
    let voice_origin = meta.get("voiceOrigin").cloned();
    let steering = meta.get("steering").and_then(Value::as_bool);
    let status = meta
        .get("status")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let model_id = meta
        .get("modelId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let provider_id = meta
        .get("providerId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let usage = meta.get("usage").and_then(|value| {
        let input_tokens = value.get("inputTokens").and_then(|v| v.as_i64())?;
        let output_tokens = value.get("outputTokens").and_then(|v| v.as_i64())?;
        let total_tokens = value
            .get("totalTokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(input_tokens + output_tokens);
        Some(MessageUsage {
            input_tokens,
            output_tokens,
            cache_read_tokens: value.get("cacheReadTokens").and_then(|v| v.as_i64()),
            cache_write_tokens: value.get("cacheWriteTokens").and_then(|v| v.as_i64()),
            reasoning_tokens: value.get("reasoningTokens").and_then(|v| v.as_i64()),
            total_tokens,
            accounting: value
                .as_object()?
                .iter()
                .filter(|(key, _)| {
                    !matches!(
                        key.as_str(),
                        "inputTokens"
                            | "outputTokens"
                            | "cacheReadTokens"
                            | "cacheWriteTokens"
                            | "reasoningTokens"
                            | "totalTokens"
                    )
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        })
    });
    let error = meta.get("error").cloned();
    let response_duration_ms = meta.get("responseDurationMs").and_then(|v| v.as_i64());
    let response_output_tokens = meta.get("responseOutputTokens").and_then(|v| v.as_i64());
    let stop_reason = meta.get("stopReason").cloned();
    let revision_root_id = meta
        .get("revisionRootId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let revision_count = meta.get("revisionCount").and_then(|v| v.as_i64());
    let active_revision = meta.get("activeRevision").and_then(|v| v.as_i64());
    let parent_tool_call_id = meta
        .get("parentToolCallId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let nested_parent_tool_call_id = meta
        .get("nestedParentToolCallId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let agent_name = meta
        .get("agentName")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let thinking = blocks
        .iter()
        .filter_map(|b| {
            (b.get("type").and_then(|t| t.as_str()) == Some("thinking"))
                .then(|| b.get("text").and_then(|v| v.as_str()))
                .flatten()
        })
        .collect::<Vec<_>>();
    let thinking = (!thinking.is_empty()).then(|| thinking.concat());
    let hosted_search = blocks
        .iter()
        .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("hostedSearch"))
        .map(|b| {
            let mut fields = b.clone();
            if let Value::Object(map) = &mut fields {
                map.remove("type");
            }
            fields
        });
    let is_error = record.is_error.then_some(true);
    let attachments = blocks
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(|t| t.as_str()) != Some("attachment") {
                return None;
            }
            Some(MessageAttachment {
                kind: block.get("kind").and_then(|v| v.as_str())?.to_string(),
                name: block.get("name").and_then(|v| v.as_str())?.to_string(),
                reference: block.get("ref").and_then(|v| v.as_str())?.to_string(),
                mime_type: block
                    .get("mimeType")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                size: block.get("size").and_then(|v| v.as_i64()),
                text: block
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                inline_path: block
                    .get("inlinePath")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            })
        })
        .collect::<Vec<_>>();
    let attachments = (!attachments.is_empty()).then_some(attachments);

    if record.role == "tool" {
        let block = blocks
            .iter()
            .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_call"))
            .cloned()
            .unwrap_or(Value::Null);
        let text = block
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();
        UiMessage {
            id: record.id,
            role: record.role,
            content: text,
            command: command.clone(),
            skill_mentions: skill_mentions.clone(),
            session_message,
            voice_origin: voice_origin.clone(),
            attachments: None,
            steering,
            created_at: record.created_at,
            thinking,
            status,
            model_id,
            provider_id,
            usage,
            response_duration_ms,
            response_output_tokens,
            stop_reason: stop_reason.clone(),
            error,
            revision_root_id,
            revision_count,
            active_revision,
            tool_name: record.tool_name,
            tool_call_id: block
                .get("callId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            tool_status: block
                .get("status")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            tool_args: block.get("args").cloned(),
            tool_result: block.get("result").cloned(),
            tool_completed_at: block
                .get("completedAt")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            tool_duration_ms: block.get("durationMs").and_then(|v| v.as_i64()),
            is_error,
            parent_tool_call_id,
            nested_parent_tool_call_id,
            agent_name,
            hosted_search: hosted_search.clone(),
            model_system: None,
        }
    } else {
        let content = blocks
            .iter()
            .filter_map(|b| match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => b.get("text").and_then(|v| v.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("");
        UiMessage {
            id: record.id,
            role: record.role,
            content,
            command,
            skill_mentions,
            session_message,
            voice_origin,
            attachments,
            steering,
            created_at: record.created_at,
            thinking,
            status,
            model_id,
            provider_id,
            usage,
            response_duration_ms,
            response_output_tokens,
            stop_reason: stop_reason.clone(),
            error,
            revision_root_id,
            revision_count,
            active_revision,
            tool_name: None,
            tool_call_id: None,
            tool_status: None,
            tool_args: None,
            tool_result: None,
            tool_completed_at: None,
            tool_duration_ms: None,
            is_error,
            parent_tool_call_id,
            nested_parent_tool_call_id,
            agent_name,
            hosted_search,
            model_system,
        }
    }
}

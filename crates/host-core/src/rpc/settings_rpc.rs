//! Persisted application preferences and their effects on the host.
use anyhow::Result;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, scheduled_tools, JsonRpcError};
use crate::{plans, providers, state::AppState, tools};

pub(super) async fn get(state: &Mutex<AppState>) -> Result<Value, JsonRpcError> {
    let st = state.lock().await;
    let stored = st
        .db
        .get_setting("app")
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    let invalid = stored.as_ref().is_some_and(|value| !value.is_object());
    let mut settings =
        normalize_settings_value(stored.filter(Value::is_object).unwrap_or_else(|| {
            json!({
                "defaultMode": "agent",
                "defaultCommandShell": tools::shell::default_shell_id(),
                "theme": "dark",
                "enterToSend": true,
                "largePasteThreshold": DEFAULT_LARGE_PASTE_THRESHOLD,
                "contextCompaction": {
                    "enabled": true,
                    "reserveTokens": 16384,
                    "keepRecentTokens": 20000
                },
                "onboardingDismissed": false
            })
        }));
    // Repair legacy non-object settings and bindings left by a deleted provider.
    if invalid
        || prune_unresolvable_image_bindings(&st.db, &mut settings)
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
    {
        st.db
            .set_setting("app", &settings)
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    }
    Ok(settings)
}

pub(super) async fn set(state: &Mutex<AppState>, params: Value) -> Result<Value, JsonRpcError> {
    validate_settings_value(&params)?;
    let mut st = state.lock().await;
    let stored = st
        .db
        .get_setting("app")
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    let incoming_shell = params.get("defaultCommandShell").and_then(Value::as_str);
    let current_effective_shell = effective_command_shell_id(stored.as_ref());
    if incoming_shell.is_some_and(|shell| current_effective_shell.as_deref() != Some(shell)) {
        gate_default_command_shell_setting(&st)?;
    }
    let mut settings = normalize_settings_value(merge_settings_value(stored, params));
    prune_unresolvable_image_bindings(&st.db, &mut settings)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    st.db
        .set_setting("app", &settings)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    // Keep the marketplace channel in memory aligned with settings.
    // Legacy source values are ignored, so this remains the official
    // channel; the renderer owns remote refresh timing.
    let (channel, custom_url) = crate::plugins::market_channel_from_settings(Some(&settings));
    st.plugins.set_market_channel(channel, custom_url);
    // A concrete app language pins the plugin display locale here, so a
    // shell that only writes settings still gets localized plugin rows.
    // `auto` is resolved by the shell and pushed through
    // `plugins.setLocale`.
    if let Some(language) = settings.get("language").and_then(Value::as_str) {
        if language != "auto" {
            st.plugins.set_locale(language);
        }
    }
    crate::network_proxy::apply_from_settings(Some(&settings));
    crate::network_policy::apply_from_settings(Some(&settings));
    Ok(json!({ "ok": true }))
}

const DEFAULT_LARGE_PASTE_THRESHOLD: i64 = 600;
const MIN_LARGE_PASTE_THRESHOLD: i64 = 1;
const MAX_LARGE_PASTE_THRESHOLD: i64 = 1_000_000;
/// Upper bound for a legacy prompt-enhancement template, in characters. The
/// setting remains validated while older profiles and config-sync backups can
/// still contain it for the optional plugin's one-time migration.
const MAX_PROMPT_ENHANCEMENT_TEMPLATE_CHARS: usize = 8000;
/// The placeholder a usable user template must carry.
const PROMPT_ENHANCEMENT_DRAFT_VARIABLE: &str = "{{draft}}";

/// A template override is either absent, blank (meaning "use the default"), or
/// a non-blank string within the length bound; a user template must also carry
/// the draft variable, or the draft never reaches the model.
fn prompt_enhancement_template_error(field: &str, value: &Value) -> Option<String> {
    let Some(text) = value.as_str() else {
        return Some(format!("{field} must be a string"));
    };
    if text.trim().is_empty() {
        return None;
    }
    if text.chars().count() > MAX_PROMPT_ENHANCEMENT_TEMPLATE_CHARS {
        return Some(format!(
            "{field} must not exceed {MAX_PROMPT_ENHANCEMENT_TEMPLATE_CHARS} characters"
        ));
    }
    if field == "promptEnhancementUserTemplate" && !text.contains(PROMPT_ENHANCEMENT_DRAFT_VARIABLE)
    {
        return Some(format!(
            "promptEnhancementUserTemplate must contain {PROMPT_ENHANCEMENT_DRAFT_VARIABLE}"
        ));
    }
    None
}

fn normalize_settings_value(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.remove("planApprovalPermissionMode");
        if object.get("defaultMode").and_then(Value::as_str) == Some("chat") {
            object.insert("defaultMode".into(), Value::String("plan".into()));
        }
        let valid_command_shell = object
            .get("defaultCommandShell")
            .and_then(Value::as_str)
            .is_some_and(tools::shell::is_known_shell_id);
        if !valid_command_shell {
            object.insert(
                "defaultCommandShell".into(),
                Value::String(tools::shell::default_shell_id().into()),
            );
        }
        let valid_large_paste_threshold = object
            .get("largePasteThreshold")
            .and_then(Value::as_i64)
            .is_some_and(|threshold| {
                (MIN_LARGE_PASTE_THRESHOLD..=MAX_LARGE_PASTE_THRESHOLD).contains(&threshold)
            });
        if !valid_large_paste_threshold {
            object.insert(
                "largePasteThreshold".into(),
                Value::Number(DEFAULT_LARGE_PASTE_THRESHOLD.into()),
            );
        }
        // The network policy replaced three per-feature switches. A section that
        // is present is written back in the shape
        // `packages/shared/src/network-policy.ts` defines: a usable `mode`, plus
        // the one-time notice flag when it is set. Anything unusable falls back
        // to the documented default, `relaxed`; the plaintext flag of a build
        // before the mode existed survives as `strict`, because its `false` was
        // the user's own answer.
        let stored_policy = object
            .get("networkPolicy")
            .filter(|value| !value.is_null())
            .cloned();
        if let Some(stored_policy) = stored_policy {
            let policy = stored_policy.as_object().cloned().unwrap_or_default();
            let mode = match policy.get("mode").and_then(Value::as_str) {
                Some("relaxed") => "relaxed",
                Some("strict") => "strict",
                _ => {
                    if policy.get("allowInsecureUserEndpoints") == Some(&Value::Bool(false)) {
                        "strict"
                    } else {
                        "relaxed"
                    }
                }
            };
            let mut next = serde_json::Map::new();
            next.insert("mode".into(), Value::String(mode.into()));
            if policy.get("insecureNoticeAcknowledged") == Some(&Value::Bool(true)) {
                next.insert("insecureNoticeAcknowledged".into(), Value::Bool(true));
            }
            object.insert("networkPolicy".into(), Value::Object(next));
        }
        // A blank override means "use the built-in default", and an unusable
        // one (wrong type, oversized, or a user template without the draft
        // variable) falls back to the default too, rather than leaving a
        // prompt that would silently drop the user's draft.
        // The system prompt is part of the feature contract, not a preference:
        // an override written by an older build is dropped so the store cannot
        // hold a value that would never be read.
        object.remove("promptEnhancementSystemPrompt");
        let template_field = "promptEnhancementUserTemplate";
        let unusable_template = match object.get(template_field) {
            None => false,
            Some(value) => match prompt_enhancement_template_error(template_field, value) {
                Some(_) => true,
                None => value.as_str().is_some_and(|text| text.trim().is_empty()),
            },
        };
        if unusable_template {
            object.remove(template_field);
        }
    }
    value
}

fn merge_settings_value(stored: Option<Value>, incoming: Value) -> Value {
    let Value::Object(incoming) = incoming else {
        return incoming;
    };
    let mut merged = match stored {
        Some(Value::Object(object)) => object,
        _ => serde_json::Map::new(),
    };
    merged.extend(incoming);
    Value::Object(merged)
}

/// Drop image-generation bindings whose provider row is gone.
///
/// `settings.set` merges into the stored object and the shell writes whole
/// snapshots back, so deleting a provider row used to leave `imageGeneration`
/// naming an id that no longer resolves. Every `GenerateImages` call then
/// answered `IMAGE_MODEL_UNAVAILABLE`, and once the candidate list was empty
/// the settings row that owns the default hid itself, so the binding could
/// neither run nor be repaired from the UI. A binding that cannot resolve is
/// therefore not a preference the store keeps: the active default falls back
/// to "no default" and the candidate list loses that entry, on read and on
/// write alike. A provider that still exists but is disabled or carries no
/// credential keeps its binding — that is a state the user repairs in
/// Settings, and no reference to it is dropped here.
///
/// The same rule config sync already enforces when it applies a bundle
/// (`validate_application_references`), applied to the local settings channel
/// so a stale id cannot be written into or read out of the store.
fn prune_unresolvable_image_bindings(
    db: &crate::db::Database,
    settings: &mut Value,
) -> Result<bool> {
    let Some(object) = settings.as_object_mut() else {
        return Ok(false);
    };
    let resolves = |binding: &Value| -> Result<bool> {
        match binding.get("providerId").and_then(Value::as_str) {
            Some(provider_id) => providers::provider_exists(db, provider_id),
            None => Ok(false),
        }
    };
    let mut changed = false;
    let active_is_stale = match object.get("imageGeneration") {
        Some(binding) if !binding.is_null() => !resolves(binding)?,
        _ => false,
    };
    if active_is_stale {
        object.insert("imageGeneration".into(), Value::Null);
        changed = true;
    }
    if let Some(Value::Array(candidates)) = object.get("imageGenerationModels").cloned() {
        let mut kept = Vec::with_capacity(candidates.len());
        let mut dropped = false;
        for candidate in candidates {
            if resolves(&candidate)? {
                kept.push(candidate);
            } else {
                dropped = true;
            }
        }
        if dropped {
            object.insert("imageGenerationModels".into(), Value::Array(kept));
            changed = true;
        }
    }
    Ok(changed)
}

fn effective_command_shell_id(settings: Option<&Value>) -> Option<String> {
    let configured = settings
        .and_then(|value| value.get("defaultCommandShell"))
        .and_then(Value::as_str);
    tools::shell::catalog(configured)
        .effective
        .map(|shell| shell.id)
}

fn validate_settings_value(value: &Value) -> Result<(), JsonRpcError> {
    let object = value.as_object().ok_or_else(|| {
        rpc_err(
            1002,
            "application settings must be an object",
            "INVALID_PARAMS",
        )
    })?;
    if let Some(model) = object.get("scheduledDefaultModel").filter(|v| !v.is_null()) {
        scheduled_tools::approved_model(Some(model))?;
        if !model["providerId"].is_string() || !model["modelId"].is_string() {
            return Err(rpc_err(
                1002,
                "scheduled default requires a provider and model",
                "INVALID_PARAMS",
            ));
        }
    }
    if let Some(policy) = object.get("networkPolicy").filter(|v| !v.is_null()) {
        let Some(policy) = policy.as_object() else {
            return Err(rpc_err(
                1002,
                "networkPolicy must be an object",
                "INVALID_PARAMS",
            ));
        };
        if policy
            .get("mode")
            .is_some_and(|mode| !matches!(mode.as_str(), Some("relaxed") | Some("strict")))
        {
            return Err(rpc_err(
                1002,
                "networkPolicy.mode must be relaxed or strict",
                "INVALID_PARAMS",
            ));
        }
        if policy
            .get("insecureNoticeAcknowledged")
            .is_some_and(|flag| !flag.is_boolean())
        {
            return Err(rpc_err(
                1002,
                "insecureNoticeAcknowledged must be a boolean",
                "INVALID_PARAMS",
            ));
        }
    }
    if let Some(binding) = object.get("imageGeneration").filter(|v| !v.is_null()) {
        for (key, max) in [("providerId", 128), ("modelId", 256)] {
            if !binding
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= max)
            {
                return Err(rpc_err(
                    1002,
                    "invalid image generation binding",
                    "INVALID_PARAMS",
                ));
            }
        }
    }
    if let Some(candidates) = object.get("imageGenerationModels").filter(|v| !v.is_null()) {
        let Some(candidates) = candidates.as_array() else {
            return Err(rpc_err(
                1002,
                "imageGenerationModels must be an array",
                "INVALID_PARAMS",
            ));
        };
        if candidates.len() > 128 {
            return Err(rpc_err(
                1002,
                "imageGenerationModels contains too many models",
                "INVALID_PARAMS",
            ));
        }
        for binding in candidates {
            for (key, max) in [("providerId", 128), ("modelId", 256)] {
                if !binding
                    .get(key)
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty() && s.len() <= max)
                {
                    return Err(rpc_err(
                        1002,
                        "invalid image generation candidate",
                        "INVALID_PARAMS",
                    ));
                }
            }
        }
    }
    if let Some(template_value) = object.get("promptEnhancementUserTemplate") {
        if let Some(message) =
            prompt_enhancement_template_error("promptEnhancementUserTemplate", template_value)
        {
            return Err(rpc_err(1002, message, "INVALID_PARAMS"));
        }
    }
    if let Some(preference) = object.get("updatePreference") {
        if !matches!(preference.as_str(), Some("automatic") | Some("manual")) {
            return Err(rpc_err(
                1002,
                "updatePreference must be automatic or manual",
                "INVALID_PARAMS",
            ));
        }
    }
    if let Some(version) = object.get("lastNotifiedUpdateVersion") {
        let Some(version) = version.as_str() else {
            return Err(rpc_err(
                1002,
                "lastNotifiedUpdateVersion must be a non-empty string",
                "INVALID_PARAMS",
            ));
        };
        if version.trim().is_empty() || version.len() > 128 {
            return Err(rpc_err(
                1002,
                "lastNotifiedUpdateVersion must contain 1 to 128 characters",
                "INVALID_PARAMS",
            ));
        }
    }
    if let Some(version) = object.get("updateDismissedVersion") {
        match version {
            serde_json::Value::Null => {}
            serde_json::Value::String(version) => {
                if version.trim().is_empty() || version.len() > 128 {
                    return Err(rpc_err(
                        1002,
                        "updateDismissedVersion must contain 1 to 128 characters",
                        "INVALID_PARAMS",
                    ));
                }
            }
            _ => {
                return Err(rpc_err(
                    1002,
                    "updateDismissedVersion must be a string or null",
                    "INVALID_PARAMS",
                ));
            }
        }
    }
    if let Some(infinite_retry) = object.get("infiniteProviderRetry") {
        if !infinite_retry.is_boolean() {
            return Err(rpc_err(
                1002,
                "infiniteProviderRetry must be a boolean",
                "INVALID_PARAMS",
            ));
        }
    }
    if let Some(keep_awake) = object.get("keepAwakeWhileRunning") {
        if !keep_awake.is_boolean() {
            return Err(rpc_err(
                1002,
                "keepAwakeWhileRunning must be a boolean",
                "INVALID_PARAMS",
            ));
        }
    }
    if let Some(threshold_value) = object.get("largePasteThreshold") {
        let Some(threshold) = threshold_value.as_i64() else {
            return Err(rpc_err(
                1002,
                "largePasteThreshold must be an integer",
                "INVALID_PARAMS",
            ));
        };
        if !(MIN_LARGE_PASTE_THRESHOLD..=MAX_LARGE_PASTE_THRESHOLD).contains(&threshold) {
            return Err(rpc_err(
                1002,
                format!(
                    "largePasteThreshold must be between {MIN_LARGE_PASTE_THRESHOLD} and {MAX_LARGE_PASTE_THRESHOLD}"
                ),
                "INVALID_PARAMS",
            ));
        }
    }
    if let Err(message) = crate::network_proxy::validate_network_proxy(value) {
        return Err(rpc_err(1002, message, "INVALID_PARAMS"));
    }
    let Some(shell_value) = object.get("defaultCommandShell") else {
        return Ok(());
    };
    let Some(shell_id) = shell_value.as_str() else {
        return Err(rpc_err(
            1002,
            "defaultCommandShell must be a supported command shell ID",
            "COMMAND_SHELL_INVALID",
        ));
    };
    if !tools::shell::is_known_shell_id(shell_id) {
        return Err(rpc_err(
            1002,
            format!("unknown command shell ID '{shell_id}'"),
            "COMMAND_SHELL_INVALID",
        ));
    }
    let catalog = tools::shell::catalog(None);
    if !catalog
        .choices
        .iter()
        .any(|choice| choice.id == shell_id && choice.available)
    {
        return Err(rpc_err(
            1002,
            format!("command shell ID '{shell_id}' is unavailable on this platform"),
            "COMMAND_SHELL_INVALID",
        ));
    }
    Ok(())
}

fn gate_default_command_shell_setting(state: &AppState) -> Result<(), JsonRpcError> {
    plans::expire_pending_approvals(&state.db)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    let blocked: bool = state
        .db
        .conn()
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM turns WHERE status = 'running'
             ) OR EXISTS(
                 SELECT 1 FROM plan_approvals WHERE status = 'pending'
             ) OR EXISTS(
                 SELECT 1 FROM plan_approvals
                 WHERE execution_state IN ('queued', 'running')
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    if blocked {
        return Err(rpc_err(
            1008,
            "defaultCommandShell can only change while all sessions are idle",
            "PLAN_CONFIGURATION_BLOCKED",
        ));
    }
    Ok(())
}

pub(super) fn command_shell_catalog(
    state: &AppState,
) -> Result<tools::shell::ShellCatalog, JsonRpcError> {
    let settings = state
        .db
        .get_setting("app")
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
        .unwrap_or_else(|| json!({}));
    let configured_id = settings.get("defaultCommandShell").and_then(Value::as_str);
    Ok(tools::shell::catalog(configured_id))
}

#[cfg(test)]
mod image_generation_settings_tests {
    use super::*;
    #[test]
    fn validates_optional_image_binding() {
        for value in [
            json!({}),
            json!({"imageGeneration": null}),
            json!({"imageGeneration": {"providerId": "p", "modelId": "image"}}),
            json!({"imageGenerationModels": null}),
            json!({"imageGenerationModels": []}),
            json!({"imageGenerationModels": [
                {"providerId": "p", "modelId": "image-one"},
                {"providerId": "q", "modelId": "image-two"}
            ]}),
        ] {
            assert!(validate_settings_value(&value).is_ok());
        }
        for value in [
            json!(false),
            json!({}),
            json!({"providerId": "p", "modelId": " "}),
        ] {
            assert!(validate_settings_value(&json!({"imageGeneration": value})).is_err());
        }
        for value in [
            json!(false),
            json!({}),
            json!([{"providerId": "p", "modelId": " "}]),
        ] {
            assert!(validate_settings_value(&json!({"imageGenerationModels": value})).is_err());
        }
    }
}

#[cfg(test)]
mod update_settings_tests {
    use super::*;

    #[test]
    fn validates_update_preference_and_reminder_version() {
        for value in [
            json!({}),
            json!({"updatePreference": "automatic"}),
            json!({"updatePreference": "manual"}),
            json!({"lastNotifiedUpdateVersion": "0.15.9"}),
            json!({"updateDismissedVersion": "0.15.9"}),
            json!({"updateDismissedVersion": null}),
        ] {
            assert!(validate_settings_value(&value).is_ok(), "{value}");
        }
        for value in [
            json!({"updatePreference": "sometimes"}),
            json!({"updatePreference": null}),
            json!({"lastNotifiedUpdateVersion": "  "}),
            json!({"lastNotifiedUpdateVersion": 12}),
            json!({"lastNotifiedUpdateVersion": "x".repeat(129)}),
            json!({"updateDismissedVersion": "  "}),
            json!({"updateDismissedVersion": 12}),
            json!({"updateDismissedVersion": "x".repeat(129)}),
        ] {
            assert!(validate_settings_value(&value).is_err(), "{value}");
        }
    }
}

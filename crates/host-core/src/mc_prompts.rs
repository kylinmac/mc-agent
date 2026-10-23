//! mc-agent: system prompt templates and where they apply (MC-ADR-0010).
//!
//! One document in the key-value store: named templates (a persona that
//! replaces the default one, and rules appended after the base prompt) and
//! the rules that pick one for a conversation, by project, by model, or as
//! the global default. Electron main resolves which applies; this module only
//! keeps the document valid.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

use crate::db::{now_ms, Database};

const NAMESPACE: &str = "mc.systemPrompts";
const KEY: &str = "config";
/// One entry per conversation: the template chosen when it was started.
const SESSION_NAMESPACE: &str = "mc.sessionPrompt";

pub const MAX_TEMPLATES: usize = 50;
pub const MAX_RULES: usize = 200;
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_NAME_CHARS: usize = 80;
pub const MAX_PATTERN_CHARS: usize = 120;
pub const MAX_PATH_CHARS: usize = 4096;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplate {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub persona: String,
    #[serde(default)]
    pub append: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRule {
    pub pattern: String,
    pub template_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRule {
    pub path: String,
    pub template_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptConfig {
    #[serde(default)]
    pub templates: Vec<PromptTemplate>,
    #[serde(default)]
    pub global_template_id: Option<String>,
    #[serde(default)]
    pub model_rules: Vec<ModelRule>,
    #[serde(default)]
    pub project_rules: Vec<ProjectRule>,
    #[serde(default)]
    pub updated_at: i64,
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    anyhow!("INVALID_PARAMS: {}", message.into())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Checks a document before it is stored; returns it with blank rules dropped.
pub fn validate(mut config: PromptConfig) -> Result<PromptConfig> {
    if config.templates.len() > MAX_TEMPLATES {
        return Err(invalid(format!("at most {MAX_TEMPLATES} templates")));
    }
    let mut ids = HashSet::new();
    for template in &mut config.templates {
        if !valid_id(&template.id) {
            return Err(invalid("template id must be 1-64 letters, digits, - or _"));
        }
        if !ids.insert(template.id.clone()) {
            return Err(invalid(format!("duplicate template id {}", template.id)));
        }
        template.name = template.name.trim().to_string();
        if template.name.is_empty() || template.name.chars().count() > MAX_NAME_CHARS {
            return Err(invalid(format!(
                "template name must be 1-{MAX_NAME_CHARS} characters"
            )));
        }
        if template.persona.len() > MAX_TEXT_BYTES || template.append.len() > MAX_TEXT_BYTES {
            return Err(invalid(format!(
                "template text exceeds {MAX_TEXT_BYTES} bytes"
            )));
        }
    }
    let known = |id: &str| ids.contains(id);
    if let Some(id) = config.global_template_id.as_deref() {
        if id.is_empty() {
            config.global_template_id = None;
        } else if !known(id) {
            return Err(invalid(format!("unknown template {id}")));
        }
    }
    config
        .model_rules
        .retain(|rule| !rule.pattern.trim().is_empty());
    config
        .project_rules
        .retain(|rule| !rule.path.trim().is_empty());
    if config.model_rules.len() > MAX_RULES || config.project_rules.len() > MAX_RULES {
        return Err(invalid(format!("at most {MAX_RULES} rules of each kind")));
    }
    let mut patterns = HashSet::new();
    for rule in &mut config.model_rules {
        rule.pattern = rule.pattern.trim().to_string();
        if rule.pattern.chars().count() > MAX_PATTERN_CHARS {
            return Err(invalid("model pattern too long"));
        }
        if !patterns.insert(rule.pattern.to_lowercase()) {
            return Err(invalid(format!("duplicate model pattern {}", rule.pattern)));
        }
        if !known(&rule.template_id) {
            return Err(invalid(format!("unknown template {}", rule.template_id)));
        }
    }
    let mut paths = HashSet::new();
    for rule in &mut config.project_rules {
        rule.path = rule.path.trim().to_string();
        if rule.path.len() > MAX_PATH_CHARS {
            return Err(invalid("project path too long"));
        }
        if !paths.insert(rule.path.clone()) {
            return Err(invalid(format!("duplicate project {}", rule.path)));
        }
        if !known(&rule.template_id) {
            return Err(invalid(format!("unknown template {}", rule.template_id)));
        }
    }
    Ok(config)
}

pub fn get(db: &Database) -> Result<PromptConfig> {
    Ok(db
        .kv_get(NAMESPACE, KEY)?
        .and_then(|value| serde_json::from_value::<PromptConfig>(value).ok())
        .unwrap_or_default())
}

pub fn set(db: &Database, value: Value) -> Result<PromptConfig> {
    let config: PromptConfig =
        serde_json::from_value(value).map_err(|error| invalid(error.to_string()))?;
    let mut config = validate(config)?;
    config.updated_at = now_ms();
    db.kv_set(NAMESPACE, KEY, &serde_json::to_value(&config)?)?;
    Ok(config)
}

/// The template a conversation was started with. `None` when none was chosen
/// or the template has since been deleted, so the project, model and global
/// rules apply as before.
pub fn session_template(db: &Database, session_id: &str) -> Result<Option<String>> {
    let Some(value) = db.kv_get(SESSION_NAMESPACE, session_id)? else {
        return Ok(None);
    };
    let Some(id) = value.get("templateId").and_then(Value::as_str) else {
        return Ok(None);
    };
    Ok(get(db)?
        .templates
        .iter()
        .any(|template| template.id == id)
        .then(|| id.to_string()))
}

/// Chooses (or with `None` clears) the template for one local conversation.
pub fn set_session_template(
    db: &Database,
    session_id: &str,
    template_id: Option<&str>,
) -> Result<Option<String>> {
    if session_id.is_empty() || session_id.len() > 128 {
        return Err(invalid("invalid session id"));
    }
    if crate::sessions::session_summary(db, session_id)?.is_none() {
        return Err(invalid("session not found"));
    }
    let Some(id) = template_id.map(str::trim).filter(|id| !id.is_empty()) else {
        db.kv_delete(SESSION_NAMESPACE, session_id)?;
        return Ok(None);
    };
    if !get(db)?.templates.iter().any(|template| template.id == id) {
        return Err(invalid(format!("unknown template {id}")));
    }
    db.kv_set(
        SESSION_NAMESPACE,
        session_id,
        &serde_json::json!({ "templateId": id, "updatedAt": now_ms() }),
    )?;
    Ok(Some(id.to_string()))
}

/// Drops the choice of a deleted conversation. Best effort: a leftover entry
/// is harmless because it is only read through an existing session.
pub fn clear_session_template(db: &Database, session_id: &str) {
    let _ = db.kv_delete(SESSION_NAMESPACE, session_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    #[test]
    fn stores_and_reads_templates_and_rules() {
        let (_dir, db) = db();
        assert_eq!(get(&db).unwrap(), PromptConfig::default());
        let saved = set(
            &db,
            json!({
                "templates": [{ "id": "claude", "name": " Claude ", "persona": "You are terse.", "append": "" }],
                "globalTemplateId": "claude",
                "modelRules": [{ "pattern": " claude-* ", "templateId": "claude" }, { "pattern": " ", "templateId": "claude" }],
                "projectRules": [{ "path": "/work/app", "templateId": "claude" }]
            }),
        )
        .unwrap();
        assert_eq!(saved.templates[0].name, "Claude");
        assert_eq!(saved.model_rules.len(), 1);
        assert_eq!(saved.model_rules[0].pattern, "claude-*");
        assert_eq!(get(&db).unwrap().project_rules[0].path, "/work/app");
    }

    #[test]
    fn rejects_rules_for_unknown_templates_and_duplicates() {
        let (_dir, db) = db();
        let template = json!({ "id": "a", "name": "A" });
        assert!(set(
            &db,
            json!({ "templates": [template.clone()], "globalTemplateId": "b" })
        )
        .is_err());
        assert!(set(
            &db,
            json!({ "templates": [template.clone(), template.clone()] })
        )
        .is_err());
        assert!(set(
            &db,
            json!({ "templates": [template.clone()], "modelRules": [
                { "pattern": "gpt-*", "templateId": "a" }, { "pattern": "GPT-*", "templateId": "a" }
            ] })
        )
        .is_err());
        assert!(set(
            &db,
            json!({ "templates": [{ "id": "bad id", "name": "X" }] })
        )
        .is_err());
        assert!(set(&db, json!({ "templates": [{ "id": "x", "name": "" }] })).is_err());
    }

    #[test]
    fn a_conversation_keeps_its_own_template_choice() {
        let (_dir, db) = db();
        set(
            &db,
            json!({ "templates": [{ "id": "terse", "name": "Terse" }, { "id": "wordy", "name": "Wordy" }] }),
        )
        .unwrap();
        let session = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions::default(),
        )
        .unwrap();
        let other = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions::default(),
        )
        .unwrap();
        assert_eq!(session_template(&db, &session.id).unwrap(), None);
        assert_eq!(
            set_session_template(&db, &session.id, Some("terse")).unwrap(),
            Some("terse".to_string())
        );
        assert_eq!(
            session_template(&db, &session.id).unwrap(),
            Some("terse".to_string())
        );
        assert_eq!(session_template(&db, &other.id).unwrap(), None);
        // Changing the choice replaces it; an empty id goes back to the defaults.
        set_session_template(&db, &session.id, Some("wordy")).unwrap();
        assert_eq!(
            session_template(&db, &session.id).unwrap(),
            Some("wordy".to_string())
        );
        assert_eq!(
            set_session_template(&db, &session.id, Some("")).unwrap(),
            None
        );
        assert_eq!(session_template(&db, &session.id).unwrap(), None);
    }

    #[test]
    fn rejects_unknown_templates_and_sessions_and_ignores_deleted_templates() {
        let (_dir, db) = db();
        set(
            &db,
            json!({ "templates": [{ "id": "terse", "name": "Terse" }] }),
        )
        .unwrap();
        let session = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions::default(),
        )
        .unwrap();
        assert!(set_session_template(&db, &session.id, Some("missing")).is_err());
        assert!(set_session_template(&db, "no-such-session", Some("terse")).is_err());
        assert!(set_session_template(&db, "", None).is_err());
        set_session_template(&db, &session.id, Some("terse")).unwrap();
        // Deleting the template makes the stored choice inert.
        set(&db, json!({ "templates": [] })).unwrap();
        assert_eq!(session_template(&db, &session.id).unwrap(), None);
    }

    #[test]
    fn deleting_a_conversation_drops_its_template_choice() {
        let (_dir, db) = db();
        set(
            &db,
            json!({ "templates": [{ "id": "terse", "name": "Terse" }] }),
        )
        .unwrap();
        let session = crate::sessions::create_session_with_options(
            &db,
            crate::sessions::SessionCreateOptions::default(),
        )
        .unwrap();
        set_session_template(&db, &session.id, Some("terse")).unwrap();
        assert!(crate::sessions::delete_session(&db, &session.id).unwrap());
        assert_eq!(db.kv_get(SESSION_NAMESPACE, &session.id).unwrap(), None);
    }
}

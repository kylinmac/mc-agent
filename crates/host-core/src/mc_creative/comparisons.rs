//! Comparisons: saved sets of asset references with a note and a pick.

use super::*;

// ---- comparisons ------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub id: String,
    pub group_id: String,
    pub title: String,
    pub note: String,
    pub chosen: Option<String>,
    pub asset_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonInput {
    pub title: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub chosen: Option<String>,
    pub asset_ids: Vec<String>,
}

fn validate_comparison(
    db: &Database,
    group: &ProjectGroupRecord,
    input: &ComparisonInput,
) -> Result<()> {
    if input.asset_ids.len() < 2 || input.asset_ids.len() > MAX_COMPARISON_ITEMS {
        return Err(anyhow!(
            "INVALID_ARGUMENT: compare 2 to {MAX_COMPARISON_ITEMS} assets"
        ));
    }
    for id in &input.asset_ids {
        group_asset(db, group, id)?;
    }
    if input
        .chosen
        .as_ref()
        .is_some_and(|chosen| !input.asset_ids.contains(chosen))
    {
        return Err(anyhow!(
            "INVALID_ARGUMENT: the pick must be one of the compared assets"
        ));
    }
    if input.title.trim().is_empty()
        || input.title.chars().count() > 200
        || input.note.chars().count() > MAX_TEXT_CHARS
    {
        return Err(anyhow!(
            "INVALID_ARGUMENT: a comparison needs a short title"
        ));
    }
    Ok(())
}

fn write_comparison_items(db: &Database, id: &str, asset_ids: &[String]) -> Result<()> {
    db.conn().execute(
        "DELETE FROM mc_creative_comparison_items WHERE comparison_id = ?1",
        params![id],
    )?;
    for (position, asset) in asset_ids.iter().enumerate() {
        db.conn().execute(
            "INSERT OR IGNORE INTO mc_creative_comparison_items (comparison_id, asset_id, position) VALUES (?1, ?2, ?3)",
            params![id, asset, position as i64],
        )?;
    }
    Ok(())
}

pub fn get_comparison(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<Comparison> {
    ensure_schema(db)?;
    let mut comparison = db
        .conn()
        .query_row(
            "SELECT id, group_id, title, note, chosen, created_at, updated_at FROM mc_creative_comparisons WHERE id = ?1 AND group_id = ?2",
            params![id, group.id],
            |row| {
                Ok(Comparison {
                    id: row.get(0)?,
                    group_id: row.get(1)?,
                    title: row.get(2)?,
                    note: row.get(3)?,
                    chosen: row.get(4)?,
                    asset_ids: Vec::new(),
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| anyhow!("NOT_FOUND: comparison not found"))?;
    let mut stmt = db.conn().prepare(
        "SELECT asset_id FROM mc_creative_comparison_items WHERE comparison_id = ?1 ORDER BY position",
    )?;
    comparison.asset_ids = stmt
        .query_map(params![id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(comparison)
}

pub fn list_comparisons(db: &Database, group: &ProjectGroupRecord) -> Result<Vec<Comparison>> {
    ensure_schema(db)?;
    let mut stmt = db.conn().prepare(
        "SELECT id FROM mc_creative_comparisons WHERE group_id = ?1 ORDER BY updated_at DESC",
    )?;
    let ids: Vec<String> = stmt
        .query_map(params![group.id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    ids.iter().map(|id| get_comparison(db, group, id)).collect()
}

pub fn save_comparison(
    db: &Database,
    group: &ProjectGroupRecord,
    id: Option<&str>,
    input: ComparisonInput,
) -> Result<Comparison> {
    ensure_schema(db)?;
    validate_comparison(db, group, &input)?;
    let now = now_ms();
    let id = match id {
        Some(id) => {
            get_comparison(db, group, id)?;
            db.conn().execute(
                "UPDATE mc_creative_comparisons SET title = ?2, note = ?3, chosen = ?4, updated_at = ?5 WHERE id = ?1",
                params![id, input.title.trim(), input.note, input.chosen, now],
            )?;
            id.to_string()
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            db.conn().execute(
                "INSERT INTO mc_creative_comparisons (id, group_id, title, note, chosen, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![id, group.id, input.title.trim(), input.note, input.chosen, now],
            )?;
            id
        }
    };
    write_comparison_items(db, &id, &input.asset_ids)?;
    get_comparison(db, group, &id)
}

pub fn delete_comparison(db: &Database, group: &ProjectGroupRecord, id: &str) -> Result<()> {
    get_comparison(db, group, id)?;
    db.conn().execute(
        "DELETE FROM mc_creative_comparison_items WHERE comparison_id = ?1",
        params![id],
    )?;
    db.conn().execute(
        "DELETE FROM mc_creative_comparisons WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

//! The creative studio's tables. They are mc-owned (`mc_creative_*`) and
//! versioned in `mc_schema_versions` under their own key, so they never touch
//! upstream's `user_version`. Each step runs once, in order, in a transaction;
//! databases made before the version was recorded are brought up by step 1,
//! which only adds what is missing.

use super::*;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS mc_creative_assets (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  origin      TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'image',
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  mime        TEXT,
  width       INTEGER,
  height      INTEGER,
  bytes       INTEGER NOT NULL DEFAULT 0,
  title       TEXT NOT NULL DEFAULT '',
  favorite    INTEGER NOT NULL DEFAULT 0,
  job_id      TEXT,
  result_index INTEGER,
  created_at  INTEGER NOT NULL,
  removed_at  INTEGER,
  category    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mc_creative_assets_group ON mc_creative_assets(group_id, created_at);
CREATE TABLE IF NOT EXISTS mc_creative_jobs (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  entry       TEXT NOT NULL,
  session_id  TEXT,
  provider_id TEXT,
  model_id    TEXT,
  snapshot    TEXT NOT NULL,
  status      TEXT NOT NULL,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mc_creative_jobs_group ON mc_creative_jobs(group_id, created_at);
CREATE TABLE IF NOT EXISTS mc_creative_job_results (
  job_id    TEXT NOT NULL,
  idx       INTEGER NOT NULL,
  status    TEXT NOT NULL,
  path      TEXT,
  asset_id  TEXT,
  error     TEXT,
  PRIMARY KEY (job_id, idx)
);
CREATE TABLE IF NOT EXISTS mc_creative_asset_refs (
  asset_id     TEXT NOT NULL,
  ref_asset_id TEXT NOT NULL,
  position     INTEGER NOT NULL,
  role         TEXT NOT NULL,
  PRIMARY KEY (asset_id, ref_asset_id, role)
);
CREATE TABLE IF NOT EXISTS mc_creative_categories (
  group_id   TEXT NOT NULL,
  path       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, path)
);
CREATE TABLE IF NOT EXISTS mc_creative_comparisons (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  chosen     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mc_creative_comparison_items (
  comparison_id TEXT NOT NULL,
  asset_id      TEXT NOT NULL,
  position      INTEGER NOT NULL,
  PRIMARY KEY (comparison_id, asset_id)
);
";

/// The key and version of these tables in `mc_schema_versions`.
const MODULE: &str = "creative";
const LATEST: i64 = 1;

/// Bring the tables to the latest version. Cheap once current: one read.
pub(super) fn ensure_schema(db: &Database) -> Result<()> {
    let conn = db.conn();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mc_schema_versions (
           module  TEXT PRIMARY KEY,
           version INTEGER NOT NULL
         )",
    )
    .context("create mc schema versions")?;
    let version: i64 = conn
        .query_row(
            "SELECT version FROM mc_schema_versions WHERE module = ?1",
            [MODULE],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    if version >= LATEST {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    if version < 1 {
        step_1(&tx)?;
    }
    tx.execute(
        "INSERT INTO mc_schema_versions (module, version) VALUES (?1, ?2)
         ON CONFLICT(module) DO UPDATE SET version = excluded.version",
        params![MODULE, LATEST],
    )?;
    tx.commit().context("upgrade creative tables")?;
    Ok(())
}

/// Step 1: the tables, and the category column that tables made before
/// categories existed lack.
fn step_1(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)
        .context("create creative tables")?;
    let has_category: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('mc_creative_assets') WHERE name = 'category'")?
        .exists([])?;
    if !has_category {
        conn.execute_batch(
            "ALTER TABLE mc_creative_assets ADD COLUMN category TEXT NOT NULL DEFAULT ''",
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(db: &Database) -> i64 {
        db.conn()
            .query_row(
                "SELECT version FROM mc_schema_versions WHERE module = 'creative'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn an_empty_database_gets_the_tables_and_the_version() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        ensure_schema(&db).unwrap();
        assert_eq!(version(&db), LATEST);
        // Running again changes nothing.
        ensure_schema(&db).unwrap();
        assert_eq!(version(&db), LATEST);
    }

    #[test]
    fn tables_from_before_categories_and_versions_are_upgraded_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        // The first release's assets table: no category column, no version row.
        db.conn()
            .execute_batch(
                "CREATE TABLE mc_creative_assets (
                   id TEXT PRIMARY KEY, group_id TEXT NOT NULL, origin TEXT NOT NULL,
                   kind TEXT NOT NULL DEFAULT 'image', path TEXT NOT NULL, sha256 TEXT NOT NULL,
                   mime TEXT, width INTEGER, height INTEGER, bytes INTEGER NOT NULL DEFAULT 0,
                   title TEXT NOT NULL DEFAULT '', favorite INTEGER NOT NULL DEFAULT 0,
                   job_id TEXT, result_index INTEGER, created_at INTEGER NOT NULL, removed_at INTEGER
                 );
                 INSERT INTO mc_creative_assets (id, group_id, origin, path, sha256, created_at)
                 VALUES ('a1', 'g1', 'import', '/x.png', 'h', 1);",
            )
            .unwrap();
        ensure_schema(&db).unwrap();
        assert_eq!(version(&db), LATEST);
        let (title, category): (String, String) = db
            .conn()
            .query_row(
                "SELECT title, category FROM mc_creative_assets WHERE id = 'a1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((title.as_str(), category.as_str()), ("", ""));
        // The other tables were created beside it.
        assert!(db
            .conn()
            .prepare("SELECT 1 FROM sqlite_master WHERE name = 'mc_creative_comparisons'")
            .unwrap()
            .exists([])
            .unwrap());
    }
}

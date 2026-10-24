use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub main: String,
    /// Renderer entry module (relative path). Declaring it requires the
    /// `renderer.extension` permission; the module registers UI slot
    /// components in the host renderer (`docs/plugin-plan/ui/`).
    #[serde(default, rename = "renderer")]
    pub renderer: Option<String>,
    /// Outbound actions the renderer components may dispatch; the desktop
    /// host refuses anything outside this list.
    #[serde(default, rename = "rendererActions")]
    pub renderer_actions: Vec<String>,
    /// Methods the plugin's `onRendererCall` answers for `plugin.call`.
    #[serde(default, rename = "rendererCallMethods")]
    pub renderer_call_methods: Vec<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Display strings per locale — `{ "en": { name, description, safetyNotes },
    /// "zh-CN": { … } }` — resolved against the application locale whenever a
    /// row is read. The flat `name`/`description` above stay the author's own
    /// language and are the last-resort fallback.
    #[serde(default)]
    pub i18n: Option<PluginI18nMap>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub contributes: Option<Value>,
    #[serde(default)]
    pub ui: Option<PluginUiMeta>,
    #[serde(default)]
    pub fs: Option<Value>,
    /// First-registration default for bundled plugins. Marketplace/dev
    /// installs still enable after the user grants permissions.
    #[serde(default, rename = "enabledByDefault")]
    pub enabled_by_default: Option<bool>,
}

impl PluginManager {
    pub(crate) fn read_manifest(path: &Path) -> Result<PluginManifest> {
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            bail!("PLUGIN_INVALID: manifest.json missing");
        }
        let raw = fs::read_to_string(&manifest_path)
            .with_context(|| format!("read manifest {}", manifest_path.display()))?;
        let manifest: PluginManifest =
            serde_json::from_str(&raw).map_err(|e| anyhow!("PLUGIN_INVALID: {e}"))?;
        if manifest.id.trim().is_empty() || manifest.main.trim().is_empty() {
            bail!("PLUGIN_INVALID: id/main required");
        }
        if manifest.name.trim().is_empty() || manifest.version.trim().is_empty() {
            bail!("PLUGIN_INVALID: name/version required");
        }
        let main_path = path.join(&manifest.main);
        if !main_path.exists() {
            bail!("PLUGIN_LOAD_FAILED: main entry missing");
        }
        if let Some(ui) = &manifest.ui {
            if let Some(panel) = &ui.panel {
                let panel_path = path.join(panel);
                if !panel_path.exists() {
                    bail!("PLUGIN_INVALID: ui.panel missing");
                }
            }
        }
        validate_contributions(path, &manifest)?;
        validate_renderer(path, &manifest)?;
        Ok(manifest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_manifest(root: &Path, manifest: Value) {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join("manifest.json"), manifest.to_string()).unwrap();
    }

    fn base() -> Value {
        json!({
            "schemaVersion": 1,
            "id": "demo.entries",
            "name": "Entries",
            "version": "0.1.0",
            "main": "main.js",
        })
    }

    #[test]
    fn bundled_computer_use_registers_with_native_executable_name() {
        let ship = tempdir().unwrap();
        let data = tempdir().unwrap();
        let root = ship.path().join("mc.computer-use");
        let manifest: Value = serde_json::from_str(include_str!(
            "../../../../apps/desktop/resources/plugins/mc.computer-use/manifest.json"
        ))
        .unwrap();
        write_manifest(&root, manifest);
        fs::write(root.join("main.js"), "module.exports = {};").unwrap();
        fs::create_dir_all(root.join("skills")).unwrap();
        fs::write(root.join("skills/computer-use.md"), "# Computer Use").unwrap();
        fs::create_dir_all(root.join("bin")).unwrap();
        let executable = if cfg!(windows) {
            "bin/mc-computer.exe"
        } else {
            "bin/mc-computer"
        };
        fs::write(root.join(executable), "test fixture; never executed").unwrap();
        PluginManager::read_manifest(&root).unwrap();
        let mut manager = PluginManager::new(data.path(), MarketChannel::Official, None);
        manager.sync_builtin(Some(ship.path())).unwrap();
        let plugin = manager.get("mc.computer-use").unwrap();
        assert!(plugin.bundled);
        assert!(!plugin.enabled);
        assert_eq!(plugin.status, "disabled");

        fs::remove_file(root.join(executable)).unwrap();
        assert!(PluginManager::read_manifest(&root).is_err());
        fs::create_dir(root.join(executable)).unwrap();
        assert!(PluginManager::read_manifest(&root).is_err());
    }

    #[test]
    fn a_missing_main_entry_fails_the_load() {
        let dir = tempdir().unwrap();
        write_manifest(dir.path(), base());
        let error = PluginManager::read_manifest(dir.path()).unwrap_err();
        assert_eq!(error.to_string(), "PLUGIN_LOAD_FAILED: main entry missing");
    }

    #[test]
    fn mcp_executable_suffix_resolution_stays_platform_specific_and_confined() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("main.js"), "module.exports = {};").unwrap();
        fs::create_dir(dir.path().join("bin")).unwrap();
        fs::write(dir.path().join("bin/helper.exe"), "fixture").unwrap();
        fs::write(dir.path().join("bin/helper.cmd"), "fixture").unwrap();
        fs::write(dir.path().join("bin/helper.js.exe"), "fixture").unwrap();
        for (command, valid) in [
            ("bin/helper.exe", true),
            ("bin/helper", cfg!(windows)),
            ("bin/helper.js", false),
            ("bin/missing", false),
            ("../helper", false),
            ("C:/helper", false),
        ] {
            let mut manifest = base();
            manifest["permissions"] = json!(["mcp.server.local"]);
            manifest["contributes"] = json!({"mcpServers": [{
                "id": "computer", "transport": "stdio", "command": command
            }]});
            write_manifest(dir.path(), manifest);
            assert_eq!(
                PluginManager::read_manifest(dir.path()).is_ok(),
                valid,
                "{command}"
            );
        }
        fs::remove_file(dir.path().join("bin/helper.exe")).unwrap();
        let mut manifest = base();
        manifest["permissions"] = json!(["mcp.server.local"]);
        manifest["contributes"] = json!({"mcpServers": [{
            "id": "computer", "transport": "stdio", "command": "bin/helper"
        }]});
        write_manifest(dir.path(), manifest);
        assert!(
            PluginManager::read_manifest(dir.path()).is_err(),
            "no implicit cmd fallback"
        );
    }

    #[test]
    fn a_declared_panel_must_exist() {
        let dir = tempdir().unwrap();
        let mut manifest = base();
        manifest["ui"] = json!({ "panel": "ui/index.html" });
        write_manifest(dir.path(), manifest);
        fs::write(dir.path().join("main.js"), "export function onLoad() {}").unwrap();
        let error = PluginManager::read_manifest(dir.path()).unwrap_err();
        assert_eq!(error.to_string(), "PLUGIN_INVALID: ui.panel missing");

        fs::create_dir_all(dir.path().join("ui")).unwrap();
        fs::write(dir.path().join("ui/index.html"), "<!doctype html>").unwrap();
        assert!(PluginManager::read_manifest(dir.path()).is_ok());
    }
}

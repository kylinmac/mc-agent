//! Durable keypair, paired device allowlist, and single-use pairing offers.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use iroh::SecretKey;
use qrcode::render::svg;
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::proto::{PairedDeviceView, PAIR_URI_PREFIX};

const KEY_FILE: &str = "gateway-key.bin";
const DEVICES_FILE: &str = "devices.json";
const MAX_DEVICES: usize = 32;
const MAX_DEVICE_NAME_CHARS: usize = 80;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredDevice {
    device_id: String,
    name: String,
    #[serde(default)]
    platform: String,
    paired_at: u64,
    last_seen_at: u64,
}

#[derive(Debug, Clone)]
struct ActivePairingOffer {
    secret: String,
    expires_at: u64,
}

#[derive(Debug, Default)]
struct Inner {
    devices: HashMap<String, StoredDevice>,
    online_devices: HashSet<String>,
    offer: Option<ActivePairingOffer>,
    relay: Option<String>,
    addrs: Vec<String>,
}

#[derive(Clone)]
pub struct GatewayState {
    dir: PathBuf,
    hostname: String,
    inner: Arc<Mutex<Inner>>,
}

pub fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| anyhow::anyhow!("random bytes failed: {e}"))?;
    Ok(buf)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).with_context(|| format!("renaming into {}", path.display()))?;
    Ok(())
}

impl GatewayState {
    pub fn open(dir: PathBuf, hostname: String) -> Result<Self> {
        fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        let devices_path = dir.join(DEVICES_FILE);
        let mut map = HashMap::new();
        if devices_path.exists() {
            if let Ok(raw) = fs::read_to_string(&devices_path) {
                if let Ok(list) = serde_json::from_str::<Vec<StoredDevice>>(&raw) {
                    for dev in list {
                        map.insert(dev.device_id.clone(), dev);
                    }
                }
            }
        }
        Ok(Self {
            dir,
            hostname,
            inner: Arc::new(Mutex::new(Inner {
                devices: map,
                ..Default::default()
            })),
        })
    }

    pub fn hostname(&self) -> &str {
        &self.hostname
    }

    /// Load or create the gateway's durable Ed25519 identity key.
    pub fn load_or_create_secret_key(&self) -> Result<SecretKey> {
        let key_path = self.dir.join(KEY_FILE);
        if key_path.exists() {
            let bytes =
                fs::read(&key_path).with_context(|| format!("reading {}", key_path.display()))?;
            if bytes.len() == 32 {
                let mut raw = [0u8; 32];
                raw.copy_from_slice(&bytes);
                return Ok(SecretKey::from_bytes(&raw));
            }
        }
        let raw = random_bytes::<32>()?;
        let key = SecretKey::from_bytes(&raw);
        write_private_file(&key_path, &key.to_bytes())?;
        Ok(key)
    }

    pub fn set_reachable(&self, relay: Option<String>, addrs: Vec<String>) -> bool {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.relay == relay && guard.addrs == addrs {
            return false;
        }
        guard.relay = relay;
        guard.addrs = addrs;
        true
    }

    /// Create a fresh single-use pairing code and SVG QR code.
    pub fn create_pairing_offer(
        &self,
        node_id: &str,
        ttl_secs: u64,
    ) -> Result<(String, u64, String, String)> {
        let clamped_ttl = ttl_secs.clamp(60, 3600);
        let secret_bytes = random_bytes::<24>()?;
        let secret = URL_SAFE_NO_PAD.encode(secret_bytes);
        let expires_at = now_unix_secs().saturating_add(clamped_ttl);

        let (relay, addrs) = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.offer = Some(ActivePairingOffer {
                secret: secret.clone(),
                expires_at,
            });
            (guard.relay.clone(), guard.addrs.clone())
        };

        let mut url = Url::parse(PAIR_URI_PREFIX).context("parsing pair uri base")?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("node", node_id);
            query.append_pair("secret", &secret);
            query.append_pair("name", &self.hostname);
            if let Some(relay_url) = relay.as_deref() {
                query.append_pair("relay", relay_url);
            }
            for addr in addrs.iter().take(6) {
                query.append_pair("addr", addr);
            }
        }
        let pair_uri = url.to_string();
        let qr = QrCode::new(pair_uri.as_bytes()).context("encoding pairing QR")?;
        let qr_svg = qr
            .render::<svg::Color<'_>>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build();

        Ok((secret, expires_at, pair_uri, qr_svg))
    }

    /// Consume a single-use pairing secret and enroll `device_id` on success.
    pub fn consume_pairing_offer(
        &self,
        provided_secret: &str,
        device_id: String,
        device_name: String,
        platform: String,
    ) -> Result<bool> {
        let now = now_unix_secs();
        let clean_name = {
            let trimmed = device_name.trim();
            if trimmed.is_empty() {
                "Mobile Device".to_string()
            } else {
                trimmed.chars().take(MAX_DEVICE_NAME_CHARS).collect()
            }
        };
        let clean_platform = platform.trim().chars().take(24).collect::<String>();

        let snapshot_to_save = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let Some(offer) = guard.offer.as_ref() else {
                return Ok(false);
            };
            if now > offer.expires_at {
                guard.offer = None;
                return Ok(false);
            }
            if !constant_time_eq(offer.secret.as_bytes(), provided_secret.trim().as_bytes()) {
                return Ok(false);
            }
            // Single-use: consume immediately.
            guard.offer = None;

            if !guard.devices.contains_key(&device_id) && guard.devices.len() >= MAX_DEVICES {
                anyhow::bail!("paired device limit reached ({MAX_DEVICES})");
            }

            let entry = StoredDevice {
                device_id: device_id.clone(),
                name: clean_name,
                platform: if clean_platform.is_empty() {
                    "mobile".to_string()
                } else {
                    clean_platform
                },
                paired_at: now,
                last_seen_at: now,
            };
            guard.devices.insert(device_id, entry);
            guard.devices.values().cloned().collect::<Vec<_>>()
        };

        self.save_devices(&snapshot_to_save)?;
        Ok(true)
    }

    pub fn is_paired(&self, device_id: &str) -> bool {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.devices.contains_key(device_id)
    }

    pub fn mark_online(&self, device_id: &str, online: bool) -> Vec<PairedDeviceView> {
        let now = now_unix_secs();
        let (list, snapshot) = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if online {
                guard.online_devices.insert(device_id.to_string());
                if let Some(dev) = guard.devices.get_mut(device_id) {
                    dev.last_seen_at = now;
                }
            } else {
                guard.online_devices.remove(device_id);
            }
            let list = Self::views_locked(&guard);
            let snapshot = if online {
                Some(guard.devices.values().cloned().collect::<Vec<_>>())
            } else {
                None
            };
            (list, snapshot)
        };
        if let Some(snap) = snapshot {
            let _ = self.save_devices(&snap);
        }
        list
    }

    pub fn revoke_device(&self, device_id: &str) -> Result<(bool, Vec<PairedDeviceView>)> {
        let (removed, views, snapshot) = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let removed = guard.devices.remove(device_id).is_some();
            guard.online_devices.remove(device_id);
            let views = Self::views_locked(&guard);
            let snapshot = guard.devices.values().cloned().collect::<Vec<_>>();
            (removed, views, snapshot)
        };
        if removed {
            self.save_devices(&snapshot)?;
        }
        Ok((removed, views))
    }

    pub fn list_devices(&self) -> Vec<PairedDeviceView> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        Self::views_locked(&guard)
    }

    fn views_locked(guard: &Inner) -> Vec<PairedDeviceView> {
        let mut views: Vec<PairedDeviceView> = guard
            .devices
            .values()
            .map(|dev| PairedDeviceView {
                device_id: dev.device_id.clone(),
                name: dev.name.clone(),
                platform: dev.platform.clone(),
                paired_at: dev.paired_at,
                last_seen_at: dev.last_seen_at,
                online: guard.online_devices.contains(&dev.device_id),
            })
            .collect();
        views.sort_by(|a, b| b.last_seen_at.cmp(&a.last_seen_at));
        views
    }

    fn save_devices(&self, devices: &[StoredDevice]) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(devices)?;
        write_private_file(&self.dir.join(DEVICES_FILE), &bytes)
    }
}

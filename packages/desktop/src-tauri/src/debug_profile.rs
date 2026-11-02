//! Local, non-secret configuration only; never Runtime authority or live grants.
use serde::{Deserialize, Serialize};
use std::{io::{Read, Write}, os::unix::fs::{OpenOptionsExt, PermissionsExt}, path::{Path, PathBuf}};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context { pub principal_key: String, pub workspace_id: String, pub executor_id: String, pub session_id: String }
impl Context {
    pub fn validate(&self) -> Result<(), String> {
        if self.principal_key.len() != 64 || !self.principal_key.bytes().all(|c| c.is_ascii_hexdigit())
            || [&self.workspace_id, &self.executor_id, &self.session_id].iter().any(|id| !crate::desktop::valid_id(id)) {
            return Err("Invalid authenticated debug context. Reconnect to a supported Host and select a Session.".into());
        }
        Ok(())
    }
    pub fn scope(&self, origin: &str) -> Scope {
        Scope { origin: origin.into(), principal_key: self.principal_key.clone(), workspace_id: self.workspace_id.clone(), executor_id: self.executor_id.clone() }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope { origin: String, principal_key: String, workspace_id: String, executor_id: String }
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config { pub ports: Vec<u16>, pub entry_port: u16, pub scheme: String }
impl Config {
    pub fn validate(&self) -> Result<(), String> {
        crate::debug_forwarder::validate_ports(&self.ports)?;
        if !self.ports.contains(&self.entry_port) || !matches!(self.scheme.as_str(), "http" | "https") {
            return Err("Choose an entry port from the forwarded group and HTTP or HTTPS. No forwarding was enabled.".into());
        }
        Ok(())
    }
    pub fn canonical(mut self) -> Self { self.ports.sort_unstable(); self }
    pub fn url(&self) -> String { format!("{}://localhost:{}/", self.scheme, self.entry_port) }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved { schema_version: u32, scope: Scope, config: Config }
pub fn fingerprint(value: &impl Serialize) -> String {
    let mut hash = gtk::glib::Checksum::new(gtk::glib::ChecksumType::Sha256).expect("SHA256 supported");
    hash.update(&serde_json::to_vec(value).expect("serializable debug profile"));
    hash.string().expect("SHA256 digest").to_string()
}
pub fn private_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;
    if std::fs::symlink_metadata(path).map_err(|e| e.to_string())?.file_type().is_symlink() {
        return Err("Debug profile directory must not be a symbolic link. Choose a private local application data directory.".into());
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}
fn file(root: &Path, scope: &Scope) -> PathBuf { root.join(format!("{}.json", fingerprint(scope))) }
pub fn load(root: &Path, scope: &Scope) -> Result<Option<Config>, String> {
    let path = file(root, scope);
    let read = || -> Result<Option<Config>, String> {
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(value) => value, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None), Err(e) => return Err(e.to_string()),
        };
        if !metadata.is_file() || metadata.len() > 16 * 1024 || metadata.permissions().mode() & 0o077 != 0 {
            return Err("Configuration must be a private regular file of at most 16 KiB.".into());
        }
        let mut bytes = Vec::new();
        std::fs::File::open(&path).map_err(|e| e.to_string())?.take(16 * 1024 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() > 16 * 1024 { return Err("Configuration exceeds 16 KiB.".into()); }
        let saved: Saved = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if saved.schema_version != 1 || saved.scope != *scope { return Err("Unsupported version or mismatched identity scope.".into()); }
        saved.config.validate()?; Ok(Some(saved.config.canonical()))
    };
    read().map_err(|e| format!("Cannot load debug settings {}: {e} The file was not deleted or overwritten. Repair or explicitly move it aside before saving this profile.", path.display()))
}
pub fn save(root: &Path, scope: Scope, config: Config) -> Result<(), String> {
    config.validate()?;
    private_dir(root)?;
    // Never overwrite malformed, foreign-scope or insecure settings silently.
    let previous = load(root, &scope)?;
    if previous.is_none() && std::fs::read_dir(root).map_err(|e| e.to_string())?.count() >= 64 {
        return Err("The local debug profile limit (64) is reached. Review unused saved profiles before adding another; none were deleted.".into());
    }
    let path = file(root, &scope);
    let pending = path.with_extension(format!("json.{}.pending", std::process::id()));
    let mut output = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&pending)
        .map_err(|e| format!("Cannot create private debug settings: {e}. Check permissions or a pending file from an interrupted save; existing settings were not changed."))?;
    let result = (|| -> Result<(), String> {
        let bytes = serde_json::to_vec(&Saved { schema_version: 1, scope, config: config.canonical() }).map_err(|e| e.to_string())?;
        output.write_all(&bytes).map_err(|e| e.to_string())?; output.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&pending, path).map_err(|e| e.to_string())?;
        std::fs::File::open(root).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = std::fs::remove_file(pending); }
    result
}
pub fn navigation_allowed(value: &str, config: &Config) -> bool {
    let Ok(url) = tauri::Url::parse(value) else { return false };
    if !url.username().is_empty() || url.password().is_some() { return false; }
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if local { return matches!(url.scheme(), "http" | "https") && url.port_or_known_default().is_some_and(|port| config.ports.contains(&port)); }
    let host = url.host_str().unwrap_or_default().trim_matches(['[', ']']);
    if host.trim_end_matches('.') == "localhost" || host.trim_end_matches('.').ends_with(".localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.to_canonical().is_loopback() || ip.to_canonical().is_unspecified()) { return false; }
    // No HTTP LAN/custom schemes; allow ordinary HTTPS IdP redirects only.
    url.scheme() == "https"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_scope_is_not_session_or_configuration_but_cookie_profile_is() {
        let mut context = Context { principal_key: "a".repeat(64), workspace_id: "workspace-1".into(), executor_id: "executor-1".into(), session_id: "session-1".into() };
        context.validate().unwrap();
        let scope = context.scope("https://example.test"); context.session_id = "session-2".into();
        assert_eq!(scope, context.scope("https://example.test"));
        let config = Config { ports: vec![5173, 5000], entry_port: 5173, scheme: "http".into() }.canonical();
        let key = fingerprint(&(&scope, &config)); let mut other = config.clone(); other.entry_port = 5000;
        assert_ne!(key, fingerprint(&(&scope, &other)));
        context.executor_id = "executor-2".into(); assert_ne!(scope, context.scope("https://example.test"));
        let dir = std::env::temp_dir().join(format!("kala-debug-profile-{}", std::process::id()));
        save(&dir, scope.clone(), config.clone()).unwrap(); assert_eq!(load(&dir, &scope).unwrap(), Some(config.clone()));
        assert_eq!(std::fs::metadata(file(&dir, &scope)).unwrap().permissions().mode() & 0o777, 0o600);
        std::fs::write(file(&dir, &scope), b"corrupt").unwrap();
        assert!(save(&dir, scope.clone(), config).unwrap_err().contains("not deleted or overwritten"));
        assert_eq!(std::fs::read(file(&dir, &scope)).unwrap(), b"corrupt");
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn app_navigation_cannot_reach_unforwarded_local_or_privileged_schemes() {
        let config = Config { ports: vec![5173, 5000], entry_port: 5173, scheme: "http".into() };
        for url in ["http://localhost:5173/", "http://127.0.0.1:5000/api", "https://id.example.test/login"] { assert!(navigation_allowed(url, &config), "{url}"); }
        // Construct deliberately invalid synthetic URLs rather than checking in
        // credential-bearing URL literals or a noncanonical private host.
        let mapped_loopback = format!("https://[{}]:9000/", std::net::Ipv4Addr::LOCALHOST.to_ipv6_mapped());
        let mut credentialed = tauri::Url::parse("https://example.test/").unwrap();
        credentialed.set_username("fixture-user").unwrap();
        credentialed.set_password(Some("fixture-password")).unwrap();
        for url in ["https://localhost:9000/", "https://sub.localhost:9000/", "https://127.0.0.2:9000/", mapped_loopback.as_str(), "http://localhost:9000/", "file:///etc/passwd", "tauri://localhost/", "javascript:alert(1)", "http://192.0.2.2/", credentialed.as_str()] { assert!(!navigation_allowed(url, &config), "{url}"); }
    }
}

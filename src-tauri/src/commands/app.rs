//! Build information of the running application.

use serde::Serialize;
use specta::Type;

/// Static facts about the running build, shown in the status bar.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// Product name.
    pub name: &'static str,
    /// Application version (`Cargo.toml`).
    pub version: &'static str,
    /// Kernel protocol version this build speaks.
    pub protocol_version: &'static str,
    /// Operating system family, e.g. `windows`, `macos`, `linux`.
    pub os: &'static str,
    /// CPU architecture, e.g. `x86_64`, `aarch64`.
    pub arch: &'static str,
}

impl AppInfo {
    /// Describes the current build.
    #[must_use]
    pub const fn current() -> Self {
        Self {
            name: "PolyPad",
            version: env!("CARGO_PKG_VERSION"),
            protocol_version: polypad_protocol::PROTOCOL_VERSION,
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        }
    }
}

/// Returns the build information of the running application.
#[tauri::command]
#[specta::specta]
#[must_use]
pub fn app_info() -> AppInfo {
    AppInfo::current()
}

#[cfg(test)]
mod tests {
    use super::app_info;

    #[test]
    fn app_info_serializes_with_camel_case_keys() {
        let json = serde_json::to_value(app_info()).unwrap();

        assert_eq!(json["name"], "PolyPad");
        assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(json["protocolVersion"], polypad_protocol::PROTOCOL_VERSION);
        assert!(json.get("protocol_version").is_none());
    }
}

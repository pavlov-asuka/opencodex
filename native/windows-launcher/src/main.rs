//! Windows launcher for OpenCodex.
//!
//! Double-clicking this starts the gateway if it is not already running and
//! then opens the dashboard. Started with `--background` — which is how the
//! logon autostart entry runs it — it brings the gateway up without opening a
//! browser.
//!
//! It deliberately owns process startup rather than delegating to a .cmd file:
//! a batch launcher flashes a console window on every boot, and it would tie
//! the install to a system-wide Node. Resolving Node the same way the provider
//! bridge does means the gateway also runs on machines where only Codex's own
//! bundled runtime is present.

#![windows_subsystem = "windows"]

use std::env;
use std::ffi::OsStr;
use std::fs;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{exit, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

/// Keep the gateway off any console and detached from this launcher.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

const DEFAULT_PORT: u16 = 8765;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);

fn is_file(path: &Path) -> bool {
    path.is_file()
}

fn install_root() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Optional `opencodex.env` beside the executable: `KEY=VALUE` per line.
///
/// Settings such as the subagent task oracle need to survive a reboot, and a
/// file next to the app is easier to inspect and undo than more registry state.
fn load_env_file(root: &Path) -> Vec<(String, String)> {
    let mut values = Vec::new();
    let Ok(text) = fs::read_to_string(root.join("opencodex.env")) else {
        return values;
    };
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            let key = key.trim();
            if !key.is_empty() {
                values.push((key.to_string(), value.trim().trim_matches('"').to_string()));
            }
        }
    }
    values
}

fn configured_port(overrides: &[(String, String)]) -> u16 {
    overrides
        .iter()
        .find(|(key, _)| key == "OPENCODEX_PORT")
        .map(|(_, value)| value.clone())
        .or_else(|| env::var("OPENCODEX_PORT").ok())
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_PORT)
}

fn gateway_is_up(port: u16) -> bool {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    TcpStream::connect_timeout(&address.into(), Duration::from_millis(500)).is_ok()
}

/// Find a Node runtime, preferring one shipped with the app and falling back to
/// the runtime the Codex install always provides.
fn resolve_node(root: &Path) -> PathBuf {
    let mut candidates = vec![
        root.join("node.exe"),
        root.join("runtime").join("node.exe"),
        root.join("dist").join("node.exe"),
    ];
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        candidates.push(
            Path::new(&local_app_data)
                .join("OpenAI")
                .join("Codex")
                .join("bin")
                .join("node.exe"),
        );
    }
    candidates
        .into_iter()
        .find(|candidate| is_file(candidate))
        .unwrap_or_else(|| PathBuf::from("node.exe"))
}

fn start_gateway(root: &Path, overrides: &[(String, String)]) -> Result<(), String> {
    let server = root.join("dist").join("server.js");
    if !is_file(&server) {
        return Err(format!("gateway entry point not found: {}", server.display()));
    }

    let mut command = Command::new(resolve_node(root));
    command
        .arg(&server)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Detached so the gateway keeps running after this launcher exits, and
        // windowless so the autostart entry is invisible at logon.
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    for (key, value) in overrides {
        command.env(key, value);
    }

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not start the gateway: {error}"))
}

fn wait_for_gateway(port: u16) -> bool {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if gateway_is_up(port) {
            return true;
        }
        sleep(Duration::from_millis(400));
    }
    false
}

fn open_dashboard(port: u16) {
    // `explorer.exe <url>` hands the address to the default browser without
    // needing a shell or any additional dependency.
    let _ = Command::new("explorer.exe")
        .arg(format!("http://127.0.0.1:{port}"))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

/// Report a failure without a console: this runs as a windows-subsystem binary.
fn report(message: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
    use std::os::windows::ffi::OsStrExt;
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            wide(message).as_ptr(),
            wide("OpenCodex").as_ptr(),
            0x0000_0010, // MB_ICONERROR
        );
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let background = args.iter().any(|arg| arg == "--background");

    let root = install_root();
    let overrides = load_env_file(&root);
    let port = configured_port(&overrides);

    if !gateway_is_up(port) {
        if let Err(error) = start_gateway(&root, &overrides) {
            if !background {
                report(&error);
            }
            exit(1);
        }
        if !wait_for_gateway(port) {
            if !background {
                report(&format!(
                    "The OpenCodex gateway did not come up on port {port} within {} seconds.",
                    STARTUP_TIMEOUT.as_secs()
                ));
            }
            exit(1);
        }
    }

    if !background {
        open_dashboard(port);
    }
}

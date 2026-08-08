//! Windows launcher for the OpenCodex provider bridge.
//!
//! The macOS build ships `scripts/codex-provider-bridge`, a `/bin/sh` script
//! that re-execs Node against `codex-provider-bridge.js`. Windows cannot use
//! that: the Codex Desktop client resolves its app-server through
//! `CODEX_CLI_PATH` and spawns it with `child_process.spawn` and no shell,
//! which refuses `.cmd`/`.bat` targets and has no shebang support at all.
//!
//! This shim is the Windows equivalent. It:
//!   1. locates a Node runtime,
//!   2. locates `codex-provider-bridge.js` next to itself,
//!   3. runs Node with the original argv appended and stdio inherited, so the
//!      app-server JSON-RPC stream passes through untouched,
//!   4. ties the child's lifetime to its own via a job object, so killing the
//!      shim never leaves an orphaned bridge holding the Codex session.

use std::env;
use std::ffi::c_void;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

#[repr(C)]
#[derive(Default)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
#[derive(Default)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
    fn SetInformationJobObject(job: *mut c_void, class: i32, info: *mut c_void, len: u32) -> i32;
    fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
}

/// Create a job object that kills its members once the last handle closes.
///
/// Returning the handle keeps it alive for the life of the shim; letting the
/// process exit closes it and takes the bridge down with it.
fn create_kill_on_close_job() -> Option<*mut c_void> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info = JobObjectExtendedLimitInformation::default();
        info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
        );
        if ok == 0 {
            return None;
        }
        Some(job)
    }
}

fn is_file(path: &Path) -> bool {
    path.is_file()
}

fn env_path(name: &str) -> Option<PathBuf> {
    let raw = env::var(name).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if is_file(&path) {
        Some(path)
    } else {
        None
    }
}

/// Find a Node runtime, preferring one shipped beside the bridge so the
/// routing does not depend on whatever Node happens to be on PATH.
fn resolve_node(bridge_dir: &Path) -> PathBuf {
    if let Some(explicit) = env_path("OPENCODEX_PROVIDER_BRIDGE_NODE") {
        return explicit;
    }

    let mut candidates: Vec<PathBuf> = vec![
        bridge_dir.join("node.exe"),
        bridge_dir.join("runtime").join("node.exe"),
    ];
    if let Some(parent) = bridge_dir.parent() {
        candidates.push(parent.join("node.exe"));
        candidates.push(parent.join("runtime").join("node.exe"));
    }
    // The Codex install always ships a Node runtime; use it as a last resort so
    // the bridge still starts on machines without a system-wide Node.
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        candidates.push(
            Path::new(&local_app_data)
                .join("OpenAI")
                .join("Codex")
                .join("bin")
                .join("node.exe"),
        );
    }

    for candidate in candidates {
        if is_file(&candidate) {
            return candidate;
        }
    }
    // Fall back to PATH resolution by CreateProcess.
    PathBuf::from("node.exe")
}

/// Find the script to run.
///
/// The shim resolves `<own-name>.mjs`/`<own-name>.js` beside itself, so the
/// build's `codex-provider-bridge.exe` picks up `codex-provider-bridge.js`
/// automatically. Keying off its own name also means a copy under another name
/// launches that script instead, which is what lets the Windows test harness
/// stand up a fake native app-server that Codex Desktop can actually spawn.
fn resolve_bridge_script(executable: &Path, bridge_dir: &Path) -> Option<PathBuf> {
    if let Some(explicit) = env_path("OPENCODEX_PROVIDER_BRIDGE_SCRIPT") {
        return Some(explicit);
    }
    let stem = executable
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("codex-provider-bridge");

    let mut candidates = vec![
        bridge_dir.join(format!("{stem}.mjs")),
        bridge_dir.join(format!("{stem}.js")),
    ];
    if stem != "codex-provider-bridge" {
        candidates.push(bridge_dir.join("codex-provider-bridge.js"));
    }
    if let Some(parent) = bridge_dir.parent() {
        candidates.push(parent.join("codex-provider-bridge.js"));
        candidates.push(parent.join("dist").join("codex-provider-bridge.js"));
    }
    candidates.into_iter().find(|candidate| is_file(candidate))
}

fn main() {
    let executable = env::current_exe().unwrap_or_else(|error| {
        eprintln!("[opencodex-bridge] cannot resolve own path: {error}");
        exit(70);
    });
    let bridge_dir = executable
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let script = resolve_bridge_script(&executable, &bridge_dir).unwrap_or_else(|| {
        eprintln!(
            "[opencodex-bridge] no bridge script found next to {}",
            bridge_dir.display()
        );
        exit(70);
    });
    let node = resolve_node(&bridge_dir);

    let mut command = Command::new(&node);
    command.arg(&script);
    command.args(env::args_os().skip(1));

    // stdio is inherited by default, which is what keeps the app-server
    // JSON-RPC framing byte-for-byte identical to the native binary.
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!(
                "[opencodex-bridge] failed to start {} {}: {error}",
                node.display(),
                script.display()
            );
            exit(70);
        }
    };

    // Best effort: if the job object cannot be created the bridge still works,
    // it just loses the guarantee that it exits with this shim.
    if let Some(job) = create_kill_on_close_job() {
        unsafe {
            AssignProcessToJobObject(job, child.as_raw_handle() as *mut c_void);
        }
    }

    match child.wait() {
        Ok(status) => exit(status.code().unwrap_or(0)),
        Err(error) => {
            eprintln!("[opencodex-bridge] bridge process failed: {error}");
            exit(70);
        }
    }
}

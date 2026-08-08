#!/usr/bin/env node
/**
 * Cross-platform gateway build.
 *
 * This replaces the previous inline `npm run build` chain, which relied on
 * `rm -rf`, `mv`, `printf`, `cp` and `chmod` and therefore only ran on macOS
 * and Linux. The steps are unchanged; they are just expressed with Node APIs so
 * a Windows package can be produced from Windows.
 *
 * Usage:
 *   node scripts/build.mjs                # host platform
 *   node scripts/build.mjs --windows      # also build the Windows bridge shim
 *   node scripts/build.mjs --skip-native  # never build the shim
 */

import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rm, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist");
const args = new Set(process.argv.slice(2));

const wantsWindowsShim = args.has("--windows") || (process.platform === "win32" && !args.has("--skip-native"));

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", cwd: repoRoot, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} exited with ${result.status}`);
  }
}

async function compileTypeScript() {
  console.log("Compiling TypeScript...");
  // Invoke the compiler entry point directly rather than the `.cmd` shim, which
  // Node refuses to spawn without a shell on Windows.
  const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) throw new Error("typescript is not installed; run `npm install` first");
  run(process.execPath, [tsc]);
}

/**
 * `dist/server.js` becomes a one-line re-export so the gateway can be started
 * either directly or through the packaged launcher.
 */
async function splitServerEntry() {
  const compiled = path.join(distDir, "server.js");
  if (!existsSync(compiled)) throw new Error(`expected ${compiled} to exist after compilation`);
  await rename(compiled, path.join(distDir, "gateway-entry.js"));
  await writeFile(path.join(distDir, "server.js"), 'import "./gateway-entry.js";\n', "utf-8");
}

/** POSIX launcher: a `/bin/sh` wrapper that re-execs Node. */
async function stagePosixLauncher() {
  const source = path.join(repoRoot, "scripts", "codex-provider-bridge");
  const target = path.join(distDir, "codex-provider-bridge");
  await cp(source, target);
  if (process.platform !== "win32") await chmod(target, 0o755);
}

/**
 * Windows launcher: a real PE executable. Codex Desktop spawns the path in
 * CODEX_CLI_PATH with `child_process.spawn` and no shell, so a `.cmd` wrapper
 * would be rejected outright.
 */
async function stageWindowsLauncher() {
  const crateDir = path.join(repoRoot, "native", "windows-bridge-launcher");
  const manifest = path.join(crateDir, "Cargo.toml");
  if (!existsSync(manifest)) throw new Error(`missing Rust crate at ${manifest}`);

  console.log("Building Windows provider bridge launcher...");
  // `cargo` is a real executable on every platform, so it can be spawned
  // without a shell; that keeps argument quoting intact for paths with spaces.
  const probe = spawnSync("cargo", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      "cargo is required to build the Windows provider bridge launcher. " +
      "Install Rust (https://rustup.rs) or pass --skip-native to build the gateway only.",
    );
  }
  run("cargo", ["build", "--release", "--manifest-path", manifest]);

  const built = path.join(crateDir, "target", "release", "codex-provider-bridge.exe");
  if (!existsSync(built)) throw new Error(`cargo did not produce ${built}`);

  const target = path.join(distDir, "codex-provider-bridge.exe");
  try {
    await cp(built, target);
  } catch (error) {
    if (!isLockedError(error)) throw error;
    // Windows keeps a write lock on a running image. While Codex Desktop is
    // attached the previous shim is still executing, so accept an unchanged
    // binary and only fail when the rebuild would actually differ.
    if (await sameContents(built, target)) {
      console.warn("  note: codex-provider-bridge.exe is running and unchanged; kept the existing copy");
      return;
    }
    throw new Error(
      "codex-provider-bridge.exe is running and differs from the new build. " +
      "Quit Codex Desktop (or stop the gateway) and rebuild.",
    );
  }
}

function isLockedError(error) {
  return error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "ETXTBSY";
}

async function sameContents(left, right) {
  try {
    const [a, b] = await Promise.all([readFile(left), readFile(right)]);
    return a.equals(b);
  } catch {
    return false;
  }
}

/**
 * Remove `dist`, tolerating a running `codex-provider-bridge.exe`.
 *
 * Rebuilding while Codex Desktop holds the shim open is routine, so a locked
 * entry is reported and skipped rather than failing the whole build.
 */
async function cleanDist() {
  try {
    await rm(distDir, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!isLockedError(error)) throw error;
  }

  const locked = [];
  for (const entry of await readdir(distDir)) {
    const candidate = path.join(distDir, entry);
    try {
      await rm(candidate, { recursive: true, force: true });
    } catch (error) {
      if (!isLockedError(error)) throw error;
      locked.push(entry);
    }
  }
  if (locked.length > 0) console.warn(`  note: in-use file(s) kept: ${locked.join(", ")}`);
}

async function main() {
  await cleanDist();
  await compileTypeScript();
  await mkdir(distDir, { recursive: true });
  await splitServerEntry();
  await stagePosixLauncher();
  if (wantsWindowsShim) await stageWindowsLauncher();

  console.log("");
  console.log("Build complete:");
  console.log(`  gateway: ${distDir}`);
  console.log(`  bridge:  ${path.join(distDir, wantsWindowsShim ? "codex-provider-bridge.exe" : "codex-provider-bridge")}`);
}

main().catch((error) => {
  console.error(`Build failed: ${error?.message || error}`);
  process.exit(1);
});

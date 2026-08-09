#!/usr/bin/env node
/**
 * Windows x64 packaging.
 *
 * The published `OpenCodex-*-win-x64.exe` installers are built from an app
 * shell that is not part of this repository, so this script produces what the
 * repository can actually build and verify: a self-contained portable
 * distribution holding the gateway, its production dependencies, and the
 * provider bridge launcher that Codex Desktop spawns through CODEX_CLI_PATH.
 *
 * Usage: node scripts/package-windows.mjs [--out <dir>] [--no-zip]
 */

import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const outIndex = argv.indexOf("--out");
const outputRoot = outIndex >= 0 && argv[outIndex + 1]
  ? path.resolve(argv[outIndex + 1])
  : path.join(repoRoot, "build");
const wantsZip = !argv.includes("--no-zip");

/** Locate npm's JS entry point next to the running Node installation. */
function npmCliPath() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      "could not locate npm-cli.js next to the running Node installation; " +
      "install production dependencies manually in the staged folder",
    );
  }
  return found;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", cwd: repoRoot, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} exited with ${result.status}`);
}

const LAUNCHER = `@echo off
setlocal
rem OpenCodex portable launcher.
rem Starts the gateway, which registers the provider bridge for Codex Desktop.
set "OPENCODEX_ROOT=%~dp0"
if not defined OPENCODEX_PORT set "OPENCODEX_PORT=8765"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found on PATH.
  echo Install Node.js 20 or newer from https://nodejs.org and run this again.
  pause
  exit /b 1
)

echo Starting OpenCodex gateway on port %OPENCODEX_PORT% ...
pushd "%OPENCODEX_ROOT%"
node "dist\\server.js"
popd
endlocal
`;

const README = `# OpenCodex (Windows x64, portable)

Windows build of the OpenCodex gateway with provider-bridge support.

## Run

Double-click \`Start-OpenCodex.cmd\`, or from a terminal:

    node dist\\server.js

The dashboard is served on http://127.0.0.1:8765 .

## What the gateway does on startup

1. Resolves \`dist\\codex-provider-bridge.exe\` and the native Codex app-server.
2. Publishes \`CODEX_CLI_PATH\` and the \`OPENCODEX_*\` variables into
   \`HKCU\\Environment\`, then broadcasts \`WM_SETTINGCHANGE\`.
3. Activates Codex Desktop, which spawns the bridge instead of the native
   app-server. Official GPT turns are passed through to the native binary;
   third-party models are routed to the gateway.

Stopping the gateway removes those variables again. A Desktop instance that is
already running keeps its bridge until it is restarted.

## Third-party models as Codex subagents

Codex multi-agent v2 delivers a child's task inside an \`agent_message\` whose
payload is encrypted for the ChatGPT backend, so a third-party child receives an
empty task (upstream: openai/codex#32031).

\`OPENCODEX_AGENT_MESSAGE_ORACLE=1\` enables recovery: the envelope is replayed to
ChatGPT over your own Codex credentials with a forced extraction call, and the
returned plaintext is handed to the routed child as ordinary input. It is off by
default because it spends one extra ChatGPT Responses request per distinct task
and relies on an undocumented internal format. With it off, such a turn fails
with \`unreadable_encrypted_agent_task\` rather than starting a child blind.

| Variable | Default | Purpose |
| --- | --- | --- |
| \`OPENCODEX_AGENT_MESSAGE_ORACLE\` | off | Recover encrypted subagent tasks |
| \`OPENCODEX_AGENT_MESSAGE_ORACLE_MODEL\` | \`gpt-5.6-sol\` | Model used for extraction |
| \`OPENCODEX_AGENT_MESSAGE_ORACLE_TIMEOUT_MS\` | \`60000\` | Extraction timeout |
| \`OPENCODEX_WINDOWS_LAUNCH_MODE\` | \`shell\` | \`direct\` launches Desktop bypassing shell activation |
| \`OPENCODEX_MULTI_AGENT_VERSION\` | \`v2\` | Value advertised so models are offered to spawn_agent |
| \`OPENCODEX_DEBUG_REQUEST_DUMP\` | off | Directory to record provider-bound requests |

## Restarting after changes

The bridge runs inside Codex Desktop. After upgrading this folder, restart
Desktop as well as the gateway; restarting only the gateway leaves the previous
bridge loaded.

## Requirements

- Windows 10/11 x64
- Node.js 20 or newer on PATH
- Codex Desktop installed (MSIX package \`OpenAI.Codex\`)
`;

async function main() {
  const stageDir = path.join(outputRoot, "OpenCodex-win-x64");
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  console.log("Building gateway and Windows bridge launcher...");
  run(process.execPath, [path.join(repoRoot, "scripts", "build.mjs"), "--windows"]);

  const bridgeExe = path.join(repoRoot, "dist", "codex-provider-bridge.exe");
  if (!existsSync(bridgeExe)) throw new Error(`missing ${bridgeExe}`);

  console.log("Staging distribution...");
  await cp(path.join(repoRoot, "dist"), path.join(stageDir, "dist"), { recursive: true });

  // A production-only manifest keeps the portable tree free of build tooling.
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf-8"));
  await writeFile(
    path.join(stageDir, "package.json"),
    `${JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      type: manifest.type,
      scripts: { start: "node dist/server.js" },
      dependencies: manifest.dependencies,
    }, null, 2)}\n`,
    "utf-8",
  );

  console.log("Installing production dependencies...");
  // Node refuses to spawn a .cmd without a shell, and npm is npm.cmd on
  // Windows. Drive npm's own entry point with the current Node binary instead,
  // which keeps argument quoting intact and needs no shell.
  run(process.execPath, [npmCliPath(), "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: stageDir,
  });

  await writeFile(path.join(stageDir, "Start-OpenCodex.cmd"), LAUNCHER, "utf-8");
  await writeFile(path.join(stageDir, "README.md"), README, "utf-8");

  let archive = "";
  if (wantsZip) {
    archive = path.join(outputRoot, `OpenCodex-${manifest.version}-win-x64.zip`);
    await rm(archive, { force: true });
    console.log("Compressing...");
    run("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${archive}' -CompressionLevel Optimal -Force`,
    ]);
  }

  console.log("");
  console.log("Windows package complete:");
  console.log(`  folder:  ${stageDir}`);
  if (archive) console.log(`  archive: ${archive}`);
  console.log(`  bridge:  ${path.join(stageDir, "dist", "codex-provider-bridge.exe")}`);
}

main().catch((error) => {
  console.error(`Windows packaging failed: ${error?.message || error}`);
  process.exit(1);
});

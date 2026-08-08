import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, copyFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

import {
  BRIDGE_ENVIRONMENT_VARIABLES,
  bridgeEnvironmentValues,
} from "../dist/platform/paths.js";
import { desktopController } from "../dist/platform/index.js";

const isWindows = process.platform === "win32";
const launcherPath = fileURLToPath(new URL("../dist/codex-provider-bridge.exe", import.meta.url));

test("the platform layer publishes exactly the variables Desktop needs", () => {
  const values = bridgeEnvironmentValues("C:\\bridge.exe", "C:\\codex.exe", 8765);
  assert.deepEqual(Object.keys(values).sort(), [...BRIDGE_ENVIRONMENT_VARIABLES].sort());

  // CODEX_CLI_PATH is the hook the Codex Electron app reads first when it
  // resolves its app-server, so it must point at the bridge, not the native CLI.
  assert.equal(values.CODEX_CLI_PATH, "C:\\bridge.exe");
  assert.equal(values.OPENCODEX_NATIVE_CODEX_PATH, "C:\\codex.exe");
  assert.equal(values.OPENCODEX_PROVIDER_SPLIT, "1");
  assert.equal(values.OPENCODEX_GATEWAY_PORT, "8765");
});

test("an invalid port falls back to the default gateway port", () => {
  assert.equal(bridgeEnvironmentValues("b", "n", Number.NaN).OPENCODEX_GATEWAY_PORT, "8765");
  assert.equal(bridgeEnvironmentValues("b", "n", 0).OPENCODEX_GATEWAY_PORT, "8765");
  assert.equal(bridgeEnvironmentValues("b", "n", -1).OPENCODEX_GATEWAY_PORT, "8765");
});

test("a controller is selected for this platform and exposes the full contract", () => {
  assert.equal(desktopController.platform, process.platform);
  for (const method of [
    "providerBridgePath",
    "nativeCodexExecutablePath",
    "desktopApplicationExecutable",
    "desktopAppServerState",
    "stopDesktopClients",
    "launchDesktopClient",
    "registerProviderBridgeEnvironment",
    "unregisterProviderBridgeEnvironment",
  ]) {
    assert.equal(typeof desktopController[method], "function", `${method} must be implemented`);
  }
  // Read-only probes must never throw, whatever is installed on the host.
  assert.equal(typeof desktopController.providerBridgePath(), "string");
  assert.equal(typeof desktopController.nativeCodexExecutablePath(), "string");
  assert.ok(["bridge", "native", "absent"].includes(desktopController.desktopAppServerState()));
});

test("the Windows launcher is a real PE executable, not a script", { skip: !isWindows }, () => {
  assert.ok(existsSync(launcherPath), "run `npm run build:windows` before this test");
  // Codex Desktop spawns CODEX_CLI_PATH without a shell, so a shebang script or
  // .cmd wrapper would never start. Verify the DOS/PE magic instead.
  const header = readFileSync(launcherPath).subarray(0, 2).toString("latin1");
  assert.equal(header, "MZ");
});

test("the launcher runs its sibling script and passes argv, stdio and exit code through", { skip: !isWindows }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "opencodex-launcher-"));
  try {
    // The launcher resolves "<own-name>.mjs" beside itself, which is what lets
    // one binary front both the real bridge and a test double.
    const executable = join(tempRoot, "probe.exe");
    await copyFile(launcherPath, executable);
    await writeFile(
      join(tempRoot, "probe.mjs"),
      [
        'let input = "";',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => {',
        '  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input: input.trim() }));',
        "  process.exit(7);",
        "});",
      ].join("\n"),
      "utf8",
    );

    const child = spawn(executable, ["app-server", "--flag", "a b"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end('{"jsonrpc":"2.0"}');
    const [code] = await once(child, "exit");

    assert.equal(code, 7, "exit code must propagate so Desktop sees the real result");
    assert.deepEqual(JSON.parse(stdout), {
      argv: ["app-server", "--flag", "a b"],
      input: '{"jsonrpc":"2.0"}',
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("provider credentials can be stored on this platform", async () => {
  const { secretStore } = await import("../dist/platform/secrets.js");
  // macOS uses the Keychain and Windows uses DPAPI. Before this existed the
  // Windows path threw "require macOS Keychain", so no API key could be saved
  // at all and every third-party provider was unusable.
  assert.equal(secretStore.available, isWindows || process.platform === "darwin");
  if (!secretStore.available) return;

  const service = "OpenCodex Test Service";
  const account = `provider:__unit_${process.pid}__`;
  const secret = 'sk-unit-中文-!@#$%^&*()_+-=[]{}|;:\'",.<>/?`~';
  try {
    secretStore.write(service, account, secret);
    assert.equal(secretStore.read(service, account), secret, "round trip must preserve the exact bytes");
    secretStore.remove(service, account);
    assert.equal(secretStore.read(service, account), "", "removal must clear the secret");
  } finally {
    secretStore.remove(service, account);
  }
});

test("stored credentials never land in providers.json", async () => {
  // saveProviders() strips api_key, so a credential that failed to reach the
  // OS store would be silently dropped rather than written in the clear.
  const source = readFileSync(fileURLToPath(new URL("../src_v2/services/credential_store.ts", import.meta.url)), "utf8");
  assert.match(source, /const \{ api_key: _apiKey, refresh_token: _refreshToken, \.\.\.safeProvider \} = provider/);
  assert.doesNotMatch(source, /require macOS Keychain/);
});

test("Windows discovery never returns the bridge as its own delegate", { skip: !isWindows }, () => {
  const bridge = desktopController.providerBridgePath();
  const native = desktopController.nativeCodexExecutablePath();
  if (!bridge || !native) return; // nothing installed on this host
  assert.notEqual(bridge.toLowerCase(), native.toLowerCase(),
    "delegating the bridge to itself would recurse instead of reaching native Codex");
});

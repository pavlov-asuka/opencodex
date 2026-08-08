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

test("a Windows catalog path does not corrupt config.toml", async () => {
  const { buildManagedCodexConfig, tomlString } = await import("../dist/server/gateway.js");
  const windowsPath = "C:\\Users\\Administrator\\.opencodex\\custom_model_catalog.json";

  // A TOML basic string reads backslash as an escape introducer, so writing the
  // path as "C:\Users\..." makes \U an invalid Unicode escape and the entire
  // file unparseable — Codex then fails everywhere, including Windows sandbox
  // setup. A literal string carries the path verbatim.
  assert.equal(tomlString(windowsPath), `'${windowsPath}'`);

  const config = buildManagedCodexConfig("", 8765, "token-123", windowsPath);
  assert.match(config, /model_catalog_json = '[^']*custom_model_catalog\.json'/);

  // No basic string in the generated block may carry a raw backslash.
  for (const [, value] of config.matchAll(/=\s*"([^"\n]*)"/g)) {
    assert.ok(!value.includes("\\"), `unescaped backslash in a TOML basic string: ${value}`);
  }

  // Values containing an apostrophe cannot use a literal string, so they fall
  // back to the escaped basic form.
  assert.equal(tomlString("C:\\it's\\odd"), '"C:\\\\it\'s\\\\odd"');
});

test("an official model is never rejected for lacking a third-party subagent route", () => {
  const source = readFileSync(fileURLToPath(new URL("../src_v2/server/gateway.ts", import.meta.url)), "utf8");

  // Codex opening a new session, or spawning a child, on an official model
  // reaches the subagent path with nothing for the gateway to route. Failing
  // that closed rejected legitimate official work; the native lane must win.
  assert.match(
    source,
    /if \(isSubagentRequest && !subagentRoute && !nativePassthroughTurn\) \{/,
    "the native passthrough must be honoured before rejecting a subagent turn",
  );
});

test("third-party models are eligible as Codex subagents", async () => {
  const { buildFullCatalogEntry, multiAgentVersion } = await import("../dist/services/catalog_sync.js");

  // Codex builds the spawn_agent model list from multi_agent_version and only
  // "v2" qualifies: the stock tool reports "Available models: gpt-5.6-sol,
  // gpt-5.6-terra", exactly the v2 entries. A "v1" model such as gpt-5.6-luna
  // is not offered, so emitting v1 would leave third-party models unusable.
  assert.equal(multiAgentVersion(), "v2");

  const entry = buildFullCatalogEntry("deepseek", "deepseek-v4-flash", {}, "responses");
  assert.equal(entry.multi_agent_version, "v2");
});

test("a gateway that loses the port race cannot detach the running one", () => {
  const source = readFileSync(fileURLToPath(new URL("../src_v2/server/gateway.ts", import.meta.url)), "utf8");

  // Registration must happen inside the listen callback. When it ran before
  // listen(), a second gateway would publish its own CODEX_CLI_PATH, fail with
  // EADDRINUSE, and then unregister on the way out — leaving the healthy
  // instance's Desktop pointed at variables that no longer existed.
  const listenAt = source.indexOf('this.server.listen(this.port, "127.0.0.1"');
  const registerAt = source.indexOf("registerProviderBridgeEnvironment(this.port)");
  assert.ok(listenAt >= 0, "listen call must exist");
  assert.ok(registerAt > listenAt, "the bridge environment must be published only after the port is held");

  // And only the instance that registered may unregister.
  assert.match(source, /if \(this\.registeredProviderBridge\) \{[\s\S]{0,160}unregisterProviderBridgeEnvironment\(\);/);
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

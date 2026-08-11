/**
 * The suite must not touch the machine it runs on.
 *
 * An audit on 2026-08-11 found that `npm test` published CODEX_CLI_PATH into
 * the developer's real HKCU\Environment when a test started a gateway, and
 * deleted all six bridge variables when it stopped one. It had already
 * happened: a healthy gateway was left running on 8765 with Codex Desktop no
 * longer attached to it, because the last test run cleared the registration
 * and the gateway only registers at startup.
 *
 * These tests assert behaviour, not source text. The earlier port-race guard
 * matched a regex against gateway.ts and could never have caught this.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import {
  BRIDGE_ENVIRONMENT_VARIABLES,
  createRecordingDesktopController,
  desktopController,
  inTestMode,
  noopDesktopController,
} from "../dist/platform/index.js";
import { CodexBridgeServer } from "../dist/server/gateway.js";

test("the suite runs in test mode", () => {
  // Set by scripts/run-tests.mjs. If this fails, someone invoked the runner
  // directly and every other guarantee in this file is void.
  assert.equal(inTestMode(), true, "run the suite through `npm test`, not `node --test` directly");
});

test("test mode hands out a controller that cannot reach the host", () => {
  // Not merely "a controller with the same shape" — the very object, so a
  // future platform gaining a real implementation cannot slip through.
  assert.equal(desktopController, noopDesktopController);
});

test("the no-op controller reports failure rather than pretending to register", () => {
  const before = BRIDGE_ENVIRONMENT_VARIABLES.map((name) => process.env[name]);

  // A controller that silently returned true would let the gateway believe it
  // owned a registration it never made.
  assert.equal(noopDesktopController.registerProviderBridgeEnvironment(8765), false);
  noopDesktopController.unregisterProviderBridgeEnvironment();
  noopDesktopController.stopDesktopClients();
  noopDesktopController.launchDesktopClient(true);

  assert.deepEqual(
    BRIDGE_ENVIRONMENT_VARIABLES.map((name) => process.env[name]),
    before,
    "no bridge variable may change as a side effect of the no-op controller",
  );
});

test("a full start/stop cycle leaves the host environment untouched", async () => {
  const dataDir = await fs.mkdtemp(`${os.tmpdir()}/opencodex-isolation-`);
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = `${dataDir}/config.toml`;

  const before = BRIDGE_ENVIRONMENT_VARIABLES.map((name) => process.env[name]);
  const desktop = createRecordingDesktopController();
  const server = new CodexBridgeServer(8933, desktop);

  try {
    await server.start();
    await server.stop();

    // The injected controller saw the calls...
    assert.ok(desktop.calls.includes("register:8933"), "startup must register through the injected controller");
    assert.ok(desktop.calls.includes("unregister"), "shutdown must unregister through the injected controller");

    // ...and the real environment saw none of them.
    assert.deepEqual(
      BRIDGE_ENVIRONMENT_VARIABLES.map((name) => process.env[name]),
      before,
      "start/stop must not add or remove a real bridge variable",
    );
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
    else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("stop() cancels a pending Desktop restart", async () => {
  const dataDir = await fs.mkdtemp(`${os.tmpdir()}/opencodex-timer-`);
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = `${dataDir}/config.toml`;

  const desktop = createRecordingDesktopController();
  const server = new CodexBridgeServer(8934, desktop);

  try {
    await server.start();
    await server.stop();
    // The launch timer fires 500ms after startup. Before stop() cancelled it,
    // it could restart Desktop long after the gateway had gone — during an
    // unrelated later test.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.ok(
      !desktop.calls.some((call) => call.startsWith("launchDesktopClient")),
      `a stopped gateway must not launch Desktop; saw ${JSON.stringify(desktop.calls)}`,
    );
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
    else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("the credential store follows OPENCODEX_DATA_DIR", async () => {
  const { CredentialStore } = await import("../dist/services/credential_store.js");
  const dataDir = await fs.mkdtemp(`${os.tmpdir()}/opencodex-creds-`);
  const previous = process.env.OPENCODEX_DATA_DIR;
  process.env.OPENCODEX_DATA_DIR = dataDir;

  try {
    // As a module-load-time constant this path ignored the redirect, so a test
    // that thought it was sandboxed still read and wrote the real
    // ~/.opencodex/providers.json.
    CredentialStore.saveProviders([{ name: "isolation-probe", base_url: "https://example.invalid", models: [] }]);
    const written = JSON.parse(await fs.readFile(`${dataDir}/providers.json`, "utf8"));
    assert.equal(written.providers[0].name, "isolation-probe");
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { CodexBridgeServer } from "../dist/server/gateway.js";

test("gateway refuses a second instance sharing the same runtime directory and port", async () => {
  const dataDir = await fs.mkdtemp(`${os.tmpdir()}/opencodex-lock-test-`);
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = `${dataDir}/config.toml`;
  const first = new CodexBridgeServer(8801);
  const second = new CodexBridgeServer(8801);

  try {
    await first.start();
    // Two layers refuse a second instance, and the port-identity check now
    // gets there first: it recognizes the running gateway on /health before
    // the lock file is even consulted. Either refusal is correct; what must
    // never happen is a second instance coming up and republishing its own
    // CODEX_CLI_PATH over the healthy one's.
    await assert.rejects(second.start(), /already running|already owned/);
  } finally {
    await first.stop();
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
    else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

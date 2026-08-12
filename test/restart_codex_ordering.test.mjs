/**
 * /api/restart-codex must stop the desktop before anything restarts the
 * gateway, and must not relaunch it until the new gateway is ready.
 *
 * Codex reads model_catalog_json only when its process starts, so launching
 * the desktop too early races the gateway restart and leaves the third-party
 * models invisible until the user restarts by hand a second time.
 *
 * This replaces a source-text assertion that searched for the literal
 * `execFileSync("/opt/homebrew/bin/pm2", ...)` — it broke as soon as that
 * hardcoded Homebrew path was replaced, though the ordering it guarded had
 * not changed at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { CodexBridgeServer } from "../dist/server/gateway.js";
import { createRecordingDesktopController } from "../dist/platform/index.js";

const PORT = 8942;

test("the desktop is stopped and only relaunched once the gateway is ready", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-restart-"));
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  const previousPm2 = process.env.OPENCODEX_PM2_PATH;

  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = path.join(dataDir, "config.toml");
  // No supervisor: this is the Windows layout, and the path this fork runs.
  delete process.env.OPENCODEX_PM2_PATH;

  const desktop = createRecordingDesktopController();
  const server = new CodexBridgeServer(PORT, desktop);
  await server.start();

  try {
    desktop.calls.length = 0;

    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: PORT, path: "/api/restart-codex", method: "POST", headers: { Authorization: `Bearer ${server.adminToken}` } },
        (res) => {
          let text = "";
          res.on("data", (chunk) => { text += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, text }));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });

    assert.equal(response.status, 200);
    // Without a supervisor the gateway does not restart, and the reply must
    // not claim otherwise — it used to say "网关服务正在重新启动" on every
    // platform, including the one where the Homebrew path always threw.
    assert.doesNotMatch(response.text, /网关服务正在重新启动/);

    const stopIndex = desktop.calls.indexOf("stopDesktopClients");
    assert.ok(stopIndex >= 0, "the desktop must be stopped so it re-reads the catalog");
    assert.equal(
      desktop.calls.slice(0, stopIndex).some((call) => call.startsWith("launchDesktopClient")),
      false,
      "nothing may relaunch the desktop before it has been stopped",
    );

    // The relaunch is deferred behind a timer and the readiness marker.
    assert.equal(
      desktop.calls.some((call) => call.startsWith("launchDesktopClient")),
      false,
      "the relaunch must not happen synchronously with the response",
    );
  } finally {
    await server.stop();
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
    else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
    if (previousPm2 !== undefined) process.env.OPENCODEX_PM2_PATH = previousPm2;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

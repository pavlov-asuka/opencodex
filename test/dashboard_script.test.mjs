/**
 * The dashboard script the gateway serves must actually parse.
 *
 * The control centre is built as a TypeScript template literal that emits
 * JavaScript. A literal newline inside a single-quoted JS string is perfectly
 * legal *in the template literal*, so tsc compiled it, every test passed, and
 * the page shipped with:
 *
 *   Uncaught SyntaxError: Invalid or unexpected token
 *
 * One dead script means no fetches run at all: the whole dashboard sat on
 * "正在读取接入模板…" forever. Nothing in the suite had ever parsed the emitted
 * JavaScript, only the TypeScript that produces it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { CodexBridgeServer } from "../dist/server/gateway.js";
import { createRecordingDesktopController } from "../dist/platform/index.js";

// 8943 and 8944 belong to gateway_discovery.test.mjs, which asserts that
// nothing answers on 8943. Binding it here made that test find a real gateway
// where it expected silence.
const PORT = 8951;

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: pathname }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

let server;
let dataDir;
let previousDataDir;
let previousConfigPath;
let html = "";

test("start the gateway", async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-dash-"));
  previousDataDir = process.env.OPENCODEX_DATA_DIR;
  previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = path.join(dataDir, "config.toml");
  server = new CodexBridgeServer(PORT, createRecordingDesktopController());
  await server.start();

  const page = await get("/");
  assert.equal(page.status, 200);
  html = page.body.toString("utf8");
});

test("every inline script parses as JavaScript", () => {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0, "the dashboard must ship at least one script");

  for (const [index, source] of scripts.entries()) {
    if (!source.trim()) continue;
    // new vm.Script parses without running, which is exactly the check the
    // browser performs before the first statement executes.
    assert.doesNotThrow(() => new vm.Script(source), `inline script ${index} does not parse`);
  }
});

test("the images the page references are served", async () => {
  // The logo lived only in src_v2/assets, which neither the build nor the
  // packaging step copied, so a portable install answered 404 and rendered
  // the alt text.
  const sources = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(sources.length > 0, "the page references at least one image");

  for (const source of sources) {
    if (!source.startsWith("/")) continue;
    const response = await get(source);
    assert.equal(response.status, 200, `${source} is referenced by the page but not served`);
    assert.ok(response.body.length > 0, `${source} is served empty`);
  }
});

test("stop the gateway", async () => {
  await server.stop();
  if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
  else process.env.OPENCODEX_DATA_DIR = previousDataDir;
  if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
  else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
  await fs.rm(dataDir, { recursive: true, force: true });
});

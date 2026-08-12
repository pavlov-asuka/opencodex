/**
 * A web page must not be able to spend the user's ChatGPT quota.
 *
 * Only /api/* was authenticated, while copyNativeRequestHeaders() swaps a
 * missing or placeholder bearer for the real access token out of
 * ~/.codex/auth.json. Any page in any tab could POST to
 * http://127.0.0.1:8765/v1/responses with `Content-Type: text/plain` — a
 * simple request, so the browser sends it without a preflight to refuse — and
 * have it executed under the user's identity.
 *
 * CORS stops the page reading the reply, so this is blind request forgery
 * rather than token theft. That still means someone else's page acting as the
 * user and burning their quota. Binding to 127.0.0.1 is not a defence: a
 * browser reaches loopback like any other host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { CodexBridgeServer } from "../dist/server/gateway.js";
import { createRecordingDesktopController } from "../dist/platform/index.js";

const PORT = 8941;

function post(pathname, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: "gpt-5.6", input: "hello" });
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: pathname, method: "POST", headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

let server;
let dataDir;
let previousDataDir;
let previousConfigPath;

test("start the gateway", async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-guard-"));
  previousDataDir = process.env.OPENCODEX_DATA_DIR;
  previousConfigPath = process.env.OPENCODEX_CODEX_CONFIG_PATH;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  process.env.OPENCODEX_CODEX_CONFIG_PATH = path.join(dataDir, "config.toml");
  server = new CodexBridgeServer(PORT, createRecordingDesktopController());
  await server.start();
});

test("a request carrying Origin is refused", async () => {
  for (const pathname of ["/v1/responses", "/responses", "/v1/images/generations", "/responses/compact"]) {
    const res = await post(pathname, { Origin: "https://evil.example.com" });
    assert.equal(res.status, 403, `${pathname} must refuse a browser-originated request`);
    assert.match(res.text, /browser-originated/);
  }
});

test("the CSRF-friendly content type does not help", async () => {
  // text/plain avoids the preflight, which is exactly how such a request would
  // arrive in practice.
  const res = await post("/v1/responses", { "Content-Type": "text/plain", Origin: "https://evil.example.com" });
  assert.equal(res.status, 403);
});

test("Sec-Fetch headers alone are enough to refuse", async () => {
  // A same-origin page, or one that omits Origin, still announces itself.
  assert.equal((await post("/v1/responses", { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post("/v1/responses", { "Sec-Fetch-Mode": "cors" })).status, 403);
});

test("Codex and the bridge are unaffected", async () => {
  // Neither sends Origin or Sec-Fetch-*. The request must get past the guard;
  // what it does upstream is not this test's business, only that 403 is not
  // the answer.
  const res = await post("/v1/responses", { Authorization: "Bearer dummy" });
  assert.notEqual(res.status, 403, "a non-browser caller must not be refused by the browser guard");
});

test("the dashboard itself still loads", async () => {
  const res = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: PORT, path: "/" }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
    }).on("error", reject);
  });
  assert.equal(res.status, 200, "the guard must not cover the dashboard page");
});

test("stop the gateway", async () => {
  await server.stop();
  if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
  else process.env.OPENCODEX_DATA_DIR = previousDataDir;
  if (previousConfigPath === undefined) delete process.env.OPENCODEX_CODEX_CONFIG_PATH;
  else process.env.OPENCODEX_CODEX_CONFIG_PATH = previousConfigPath;
  await fs.rm(dataDir, { recursive: true, force: true });
});

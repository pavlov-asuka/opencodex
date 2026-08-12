/**
 * The dashboard must not claim a success that did not happen.
 *
 * Two places did:
 *
 *   - The provider connection test treated only 401 and 403 as failure. A
 *     mistyped Base URL (404), a rate limit (429) or an upstream outage (5xx)
 *     all reported "连接成功", and the user only found out on a real request.
 *   - saveProviders() caught write and permission errors and logged them, and
 *     the save endpoint carried on and answered 200. A read-only directory or
 *     an antivirus lock produced "saved" in the UI and an empty configuration
 *     after the next restart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describeProviderTestStatus } from "../dist/server/gateway.js";
import { CredentialStore } from "../dist/services/credential_store.js";

test("only a 2xx counts as connected", () => {
  for (const status of [200, 201, 204, 299]) {
    assert.equal(describeProviderTestStatus(status)[0], "connected", `HTTP ${status} is a working endpoint`);
  }
  for (const status of [301, 400, 401, 403, 404, 418, 429, 500, 502, 503]) {
    assert.equal(describeProviderTestStatus(status)[0], "failed", `HTTP ${status} must not report success`);
  }
});

test("each failure explains what the user should check", () => {
  assert.match(describeProviderTestStatus(401)[1], /API Key/);
  assert.match(describeProviderTestStatus(403)[1], /API Key/);
  assert.match(describeProviderTestStatus(404)[1], /Base URL/, "404 is almost always a wrong path in the Base URL");
  assert.match(describeProviderTestStatus(429)[1], /限流/);
  assert.match(describeProviderTestStatus(502)[1], /上游/, "a 5xx is not the user's configuration");
  assert.match(describeProviderTestStatus(418)[1], /418/, "an unexpected status still names itself");
});

test("a provider save that cannot be written reports failure", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-save-"));
  const previous = process.env.OPENCODEX_DATA_DIR;
  try {
    // A path whose parent is a file, not a directory: mkdir and writeFile both
    // fail, standing in for a read-only directory or an AV lock.
    const blocker = path.join(dataDir, "blocker");
    await fs.writeFile(blocker, "not a directory", "utf8");
    process.env.OPENCODEX_DATA_DIR = path.join(blocker, "nested");

    assert.throws(
      () => CredentialStore.saveProviders([{ name: "deepseek", base_url: "https://api.deepseek.com/v1", models: [] }]),
      /无法写入服务商配置/,
      "the caller must be able to tell the save failed",
    );
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("a provider save that succeeds still returns quietly", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-save-ok-"));
  const previous = process.env.OPENCODEX_DATA_DIR;
  try {
    process.env.OPENCODEX_DATA_DIR = dataDir;
    CredentialStore.saveProviders([{ name: "deepseek", base_url: "https://api.deepseek.com/v1", models: [] }]);
    const written = JSON.parse(await fs.readFile(path.join(dataDir, "providers.json"), "utf8"));
    assert.equal(written.providers[0].name, "deepseek");
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previous;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

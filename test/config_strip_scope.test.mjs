/**
 * Leaving OpenCodex must not take the user's own config with it.
 *
 * stripManagedCodexConfig() used to delete every top-level
 * `model_catalog_json` and `openai_base_url` line in config.toml, whether or
 * not OpenCodex had written it. Pressing "restore native", "disengage", or
 * removing the last third-party model silently destroyed a user's own model
 * catalog or proxy endpoint.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { stripManagedCodexConfig, buildManagedCodexConfig } from "../dist/server/gateway.js";

test("a user's own catalog and base URL survive disengage", () => {
  const userConfig = [
    'model = "gpt-5.6"',
    "approval_policy = \"on-request\"",
    "model_catalog_json = '/home/me/my-own-catalog.json'",
    'openai_base_url = "https://corporate-proxy.example.com/v1"',
    "",
    "# >>> opencodex managed >>>",
    "model_catalog_json = '/home/me/.opencodex/custom_model_catalog.json'",
    'model_provider = "openai"',
    "# <<< opencodex managed >>>",
  ].join("\n");

  const stripped = stripManagedCodexConfig(userConfig);

  assert.match(stripped, /model_catalog_json = '\/home\/me\/my-own-catalog\.json'/, "the user's catalog must survive");
  assert.match(stripped, /openai_base_url = "https:\/\/corporate-proxy\.example\.com\/v1"/, "the user's proxy must survive");
  assert.match(stripped, /model = "gpt-5\.6"/);
  assert.match(stripped, /approval_policy/);
  assert.doesNotMatch(stripped, /opencodex managed/, "the managed block must go");
  assert.doesNotMatch(stripped, /\.opencodex/, "the managed catalog path must go");
});

test("OpenCodex's own orphaned keys are still cleaned up", () => {
  // A pre-marker installation wrote these bare, so they have to stay
  // removable — just by value, not by key name alone.
  const legacy = [
    'model = "gpt-5.6"',
    "model_catalog_json = '/home/me/.opencodex/custom_model_catalog.json'",
    'openai_base_url = "http://127.0.0.1:8765/v1"',
  ].join("\n");

  const stripped = stripManagedCodexConfig(legacy);

  assert.doesNotMatch(stripped, /model_catalog_json/);
  assert.doesNotMatch(stripped, /openai_base_url/);
  assert.match(stripped, /model = "gpt-5\.6"/);
});

test("a Windows-style managed catalog path is recognised", () => {
  const config = "model_catalog_json = 'C:\\Users\\Administrator\\.opencodex\\custom_model_catalog.json'";
  assert.equal(stripManagedCodexConfig(config), "");
});

test("localhost and IPv6 loopback count as ours; a real host does not", () => {
  assert.equal(stripManagedCodexConfig('openai_base_url = "http://localhost:8765/v1"'), "");
  assert.equal(stripManagedCodexConfig('openai_base_url = "http://[::1]:8765/v1"'), "");
  assert.match(
    stripManagedCodexConfig('openai_base_url = "https://api.openai.com/v1"'),
    /api\.openai\.com/,
    "a real endpoint is the user's, whoever set it",
  );
});

test("rebuilding the managed config still leaves exactly one of each key", () => {
  const withUserKeys = [
    'model = "gpt-5.6"',
    "model_catalog_json = '/home/me/my-own-catalog.json'",
  ].join("\n");

  const built = buildManagedCodexConfig(withUserKeys, 8765, "token", "/home/me/.opencodex/custom_model_catalog.json");

  // The user's line survives alongside the managed one, so the count is two —
  // Codex takes the last value, which is the managed one.
  assert.equal((built.match(/model_catalog_json/g) || []).length, 2);
  assert.match(built, /my-own-catalog\.json/);
  assert.ok(
    built.indexOf("my-own-catalog.json") > built.indexOf(".opencodex"),
    "the managed block is written first, so the user's own value must not be shadowed by it",
  );
  assert.equal(buildManagedCodexConfig(built, 8765, "token", "/home/me/.opencodex/custom_model_catalog.json"), built);
});

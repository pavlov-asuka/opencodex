/**
 * Protocol adapter selection.
 *
 * These guard the P5 removal of the per-vendor subscription branches in
 * router.ts. Those branches also forced an adapter and a target URL by
 * matching provider names and URL substrings; everything a legitimate
 * API-key provider needs must come from the generic factory instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AdapterFactory } from "../dist/adapters/factory.js";

test("an Anthropic Messages endpoint selects the Anthropic adapter", () => {
  assert.equal(AdapterFactory.getAdapter(undefined, "https://api.anthropic.com/v1/messages").name, "anthropic");
  assert.equal(AdapterFactory.getAdapter("anthropic", "https://example.test/v1").name, "anthropic");
  // A self-hosted or proxied deployment is recognized by the path, not by a
  // vendor name in the host.
  assert.equal(AdapterFactory.getAdapter(undefined, "https://gw.internal.test/messages").name, "anthropic");
});

test("a Gemini endpoint selects the Google adapter", () => {
  assert.equal(AdapterFactory.getAdapter("gemini", "https://example.test/v1").name, "google");
  assert.equal(AdapterFactory.getAdapter("google", "https://example.test/v1").name, "google");
  assert.equal(
    AdapterFactory.getAdapter(undefined, "https://generativelanguage.googleapis.com/v1beta/models/x:streamGenerateContent").name,
    "google",
  );
});

test("every other provider stays on the OpenAI-compatible adapter", () => {
  for (const url of [
    "https://api.deepseek.com/v1",
    "https://api.openai.com/v1",
    "https://openrouter.ai/api/v1",
    "https://anything.test/v1/chat/completions",
  ]) {
    assert.equal(AdapterFactory.getAdapter(undefined, url).name, "openai");
  }
});

test("adapter selection never keys on a vendor name", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src_v2/adapters/factory.ts", import.meta.url), "utf8");
  for (const vendor of ["anthropic.com", "claude", "cursor", "antigravity", "grok", "x.ai"]) {
    assert.doesNotMatch(source, new RegExp(vendor.replace(".", "\\."), "i"), `factory must not match on ${vendor}`);
  }
});

test("an Anthropic provider authenticates with its own API key", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src_v2/server/router.ts", import.meta.url), "utf8");
  // The x-api-key header is what an Anthropic-compatible provider validates.
  // It must be derived from the configured key, not from a vendor branch.
  assert.match(source, /adapter\.name === "anthropic" && apiKey/);
  assert.match(source, /headers\["x-api-key"\] = apiKey/);
});

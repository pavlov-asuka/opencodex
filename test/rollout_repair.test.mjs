/**
 * Rollout repair must never touch a session it cannot prove it wrote.
 *
 * The old implementation walked every file under ~/.codex/sessions AND
 * ~/.codex/archived_sessions and, in each one, deleted every reasoning record
 * whose id failed a "looks native" test and rewrote every function_call id
 * that was not `fc_*`. It then overwrote the original in place — no backup, no
 * atomic rename, no check that OpenCodex had ever been near the file.
 *
 * It runs from /api/disengage and /api/reset: the buttons a user reaches for
 * precisely when things are already broken. Session history cannot be
 * regenerated.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

/** A reasoning record this gateway mints: 16 hex chars, null encrypted_content. */
const gatewayReasoning = { type: "response_item", payload: { type: "reasoning", id: "rs_0123456789abcdef", encrypted_content: null } };
/** A native record: server-managed encrypted content. */
const nativeReasoning = { type: "response_item", payload: { type: "reasoning", id: "rs_native_abc", encrypted_content: "server-managed-blob" } };
/** Neither — an id shape we simply do not recognise. */
const unfamiliarReasoning = { type: "response_item", payload: { type: "reasoning", id: "thinking-block-7", encrypted_content: "some-other-tool" } };
const oddFunctionCall = { type: "response_item", payload: { type: "function_call", id: "call:weird/id", name: "shell" } };
const userMessage = { type: "response_item", payload: { type: "message", role: "user", content: "hello" } };

async function withCodexHome(run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-rollout-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  await fs.mkdir(path.join(home, "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, "archived_sessions"), { recursive: true });
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("a session OpenCodex never touched is left byte-identical", async () => {
  await withCodexHome(async (home) => {
    const { repairNativeRollouts } = await import("../dist/server/gateway.js");

    // Both of these would have been rewritten by the old repair: the reasoning
    // record for having an unfamiliar id, the function_call for not being fc_*.
    const foreign = path.join(home, "sessions", "someone-elses.jsonl");
    const original = jsonl([userMessage, unfamiliarReasoning, oddFunctionCall, nativeReasoning]);
    await fs.writeFile(foreign, original, "utf8");

    const summary = repairNativeRollouts();

    assert.equal(await fs.readFile(foreign, "utf8"), original, "a session with no gateway provenance must not change");
    assert.equal(summary.owned, 0);
    assert.equal(summary.repaired, 0);
    assert.equal(summary.skipped, 1);
    assert.ok(!existsSync(`${foreign}.opencodex-backup`), "nothing to back up when nothing is written");
  });
});

test("archived sessions are protected by the same gate", async () => {
  await withCodexHome(async (home) => {
    const { repairNativeRollouts } = await import("../dist/server/gateway.js");
    const archived = path.join(home, "archived_sessions", "old.jsonl");
    const original = jsonl([userMessage, unfamiliarReasoning]);
    await fs.writeFile(archived, original, "utf8");

    repairNativeRollouts();
    assert.equal(await fs.readFile(archived, "utf8"), original);
  });
});

test("a session this gateway wrote is repaired, and the original is kept", async () => {
  await withCodexHome(async (home) => {
    const { repairNativeRollouts } = await import("../dist/server/gateway.js");
    const ours = path.join(home, "sessions", "ours.jsonl");
    const original = jsonl([userMessage, gatewayReasoning, nativeReasoning, oddFunctionCall]);
    await fs.writeFile(ours, original, "utf8");

    const summary = repairNativeRollouts();

    assert.equal(summary.owned, 1);
    assert.equal(summary.repaired, 1);
    assert.equal(summary.failed, 0);

    const repaired = (await fs.readFile(ours, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(
      !repaired.some((record) => record.payload?.id === "rs_0123456789abcdef"),
      "the gateway's own reasoning record must go",
    );
    assert.ok(
      repaired.some((record) => record.payload?.id === "rs_native_abc"),
      "a native reasoning record must survive",
    );
    assert.ok(
      repaired.some((record) => record.payload?.type === "message"),
      "ordinary conversation must survive",
    );

    // The backup is the whole point: a rewrite of unregenerable data must be
    // reversible.
    assert.equal(await fs.readFile(`${ours}.opencodex-backup`, "utf8"), original);
  });
});

test("a dry run reports what it would do and writes nothing", async () => {
  await withCodexHome(async (home) => {
    const { repairNativeRollouts } = await import("../dist/server/gateway.js");
    const ours = path.join(home, "sessions", "ours.jsonl");
    const original = jsonl([userMessage, gatewayReasoning]);
    await fs.writeFile(ours, original, "utf8");

    const summary = repairNativeRollouts({ dryRun: true });

    assert.equal(summary.repaired, 1, "the file would have been repaired");
    assert.equal(await fs.readFile(ours, "utf8"), original, "a dry run must not write");
    assert.ok(!existsSync(`${ours}.opencodex-backup`));
  });
});

test("an unparseable rollout is skipped rather than rewritten", async () => {
  await withCodexHome(async (home) => {
    const { repairNativeRollouts } = await import("../dist/server/gateway.js");
    const broken = path.join(home, "sessions", "broken.jsonl");
    const original = "this is not jsonl at all\n{ half a record";
    await fs.writeFile(broken, original, "utf8");

    const summary = repairNativeRollouts();

    assert.equal(await fs.readFile(broken, "utf8"), original);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.owned, 0);
  });
});

test("no temporary file is left behind", async () => {
  await withCodexHome(async (home) => {
    const { repairNativeRollouts } = await import("../dist/server/gateway.js");
    const ours = path.join(home, "sessions", "ours.jsonl");
    await fs.writeFile(ours, jsonl([userMessage, gatewayReasoning]), "utf8");

    repairNativeRollouts();

    const leftovers = (await fs.readdir(path.join(home, "sessions"))).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "the atomic swap must not leave a temp file");
  });
});

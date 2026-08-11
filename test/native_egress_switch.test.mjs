/**
 * The official-model routing switch.
 *
 * Shipped in v2.1.0 as the headline feature and never worked once. Two stacked
 * defects:
 *
 *   1. nativeEgressEnabled() read the setting file through `require("node:fs")`
 *      in an ESM module. `require` is undefined there, so it threw on every
 *      call, an empty catch swallowed it, and the function always returned
 *      true. The file was never read.
 *   2. It consulted process.env.OPENCODEX_NATIVE_EGRESS first — the variable
 *      registration itself writes into process.env. The producer read its own
 *      output, so the first "1" latched permanently.
 *
 * Neither was caught, because the only coverage passed `intercept` to
 * nativeRuntimeArgs() by hand and never exercised the code that computes it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  adoptNativeEgressOverride,
  bridgeEnvironmentValues,
  nativeEgressEnabled,
  nativeEgressForPublishing,
  nativeEgressSetting,
  nativeEgressSettingPath,
  nativeEgressUserOverride,
} from "../dist/platform/paths.js";
import { nativeRuntimeArgs } from "../dist/codex-provider-bridge.js";

async function withDataDir(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-egress-"));
  const previousDataDir = process.env.OPENCODEX_DATA_DIR;
  const previousOverride = process.env.OPENCODEX_NATIVE_EGRESS;
  process.env.OPENCODEX_DATA_DIR = dataDir;
  delete process.env.OPENCODEX_NATIVE_EGRESS;
  try {
    return await run(dataDir);
  } finally {
    if (previousDataDir === undefined) delete process.env.OPENCODEX_DATA_DIR;
    else process.env.OPENCODEX_DATA_DIR = previousDataDir;
    if (previousOverride === undefined) delete process.env.OPENCODEX_NATIVE_EGRESS;
    else process.env.OPENCODEX_NATIVE_EGRESS = previousOverride;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const writeSetting = (dataDir, enabled) =>
  fs.writeFile(nativeEgressSettingPath(dataDir), JSON.stringify({ enabled }), "utf8");

test("the setting file is actually read", async () => {
  await withDataDir(async (dataDir) => {
    assert.equal(nativeEgressSetting(dataDir), true, "absent means on");

    await writeSetting(dataDir, false);
    // The single assertion that would have caught the shipped bug.
    assert.equal(nativeEgressSetting(dataDir), false, "enabled:false must be read from disk");

    await writeSetting(dataDir, true);
    assert.equal(nativeEgressSetting(dataDir), true);
  });
});

test("the published value ignores the variable registration wrote", async () => {
  await withDataDir(async (dataDir) => {
    await writeSetting(dataDir, false);

    // Exactly the state after one registration: the gateway put "1" in its own
    // environment. The stored setting must still win when publishing.
    process.env.OPENCODEX_NATIVE_EGRESS = "1";
    assert.equal(nativeEgressForPublishing(dataDir), false, "publishing must not read its own output");

    const values = bridgeEnvironmentValues("C:\\b.exe", "C:\\n.exe", 8765, nativeEgressForPublishing(dataDir));
    assert.equal(values.OPENCODEX_NATIVE_EGRESS, "0", "turning the switch off must republish 0");
  });
});

test("turning the switch off and back on round-trips", async () => {
  await withDataDir(async (dataDir) => {
    for (const enabled of [false, true, false]) {
      await writeSetting(dataDir, enabled);
      process.env.OPENCODEX_NATIVE_EGRESS = enabled ? "0" : "1"; // stale, opposite
      const published = bridgeEnvironmentValues("b", "n", 8765, nativeEgressForPublishing(dataDir));
      assert.equal(published.OPENCODEX_NATIVE_EGRESS, enabled ? "1" : "0");
    }
  });
});

test("a hand-set override is honoured, then adopted into the setting", async () => {
  await withDataDir(async (dataDir) => {
    await writeSetting(dataDir, true);
    process.env.OPENCODEX_NATIVE_EGRESS = "0";

    // A consumer honours it immediately...
    assert.equal(nativeEgressUserOverride(), false);
    assert.equal(nativeEgressEnabled(dataDir), false);

    // ...and startup makes it durable, so the next publish does not overwrite
    // the choice the user just made by hand.
    adoptNativeEgressOverride(dataDir);
    assert.equal(nativeEgressSetting(dataDir), false);
    assert.equal(nativeEgressForPublishing(dataDir), false);
  });
});

test("adoption is a no-op when the environment already agrees", async () => {
  await withDataDir(async (dataDir) => {
    await writeSetting(dataDir, false);
    process.env.OPENCODEX_NATIVE_EGRESS = "0";
    const before = await fs.readFile(nativeEgressSettingPath(dataDir), "utf8");
    adoptNativeEgressOverride(dataDir);
    assert.equal(await fs.readFile(nativeEgressSettingPath(dataDir), "utf8"), before);
  });
});

test("off means the native runtime arguments are not rewritten at all", () => {
  const args = ["--profile", "default", "app-server", "--listen", "stdio"];

  const intercepted = nativeRuntimeArgs(args, 43127, "/v1", true);
  assert.ok(
    intercepted.some((value) => String(value).includes("openai_base_url=http://127.0.0.1:43127")),
    "with the switch on, official traffic is pointed at the local egress router",
  );

  // The point of the switch: no rewrite means nothing in this project sits
  // between Codex and chatgpt.com.
  assert.deepEqual(nativeRuntimeArgs(args, 43127, "/v1", false), args);
});

test("no override is not the same as an override of false", () => {
  const previous = process.env.OPENCODEX_NATIVE_EGRESS;
  try {
    delete process.env.OPENCODEX_NATIVE_EGRESS;
    assert.equal(nativeEgressUserOverride(), undefined);
    process.env.OPENCODEX_NATIVE_EGRESS = "";
    assert.equal(nativeEgressUserOverride(), undefined, "empty is unset, not off");
    for (const value of ["0", "false", "off", "no", "FALSE", " Off "]) {
      process.env.OPENCODEX_NATIVE_EGRESS = value;
      assert.equal(nativeEgressUserOverride(), false, `${JSON.stringify(value)} must mean off`);
    }
    for (const value of ["1", "true", "on", "yes"]) {
      process.env.OPENCODEX_NATIVE_EGRESS = value;
      assert.equal(nativeEgressUserOverride(), true, `${JSON.stringify(value)} must mean on`);
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_NATIVE_EGRESS;
    else process.env.OPENCODEX_NATIVE_EGRESS = previous;
  }
});

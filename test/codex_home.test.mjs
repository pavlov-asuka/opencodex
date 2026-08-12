/**
 * CODEX_HOME must be honoured everywhere, or not at all.
 *
 * paths.ts has always exposed codexHomePath(), but eleven call sites built
 * `os.homedir()/.codex` by hand — several of them as module-load constants, so
 * even setting the variable before starting could not help. A user with a
 * custom Codex directory got a split brain: config written to one tree, the
 * access token read from another, sessions repaired in a third.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { codexConfigPath, codexHomePath } from "../dist/platform/paths.js";
import { readNativeAccessToken } from "../dist/server/native_headers.js";

async function withCodexHome(run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "opencodex-home-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("the base path and config path follow CODEX_HOME", async () => {
  await withCodexHome(async (home) => {
    assert.equal(codexHomePath(), home);
    assert.equal(codexConfigPath(), path.join(home, "config.toml"));
  });
});

test("the access token is read from CODEX_HOME, not the default tree", async () => {
  await withCodexHome(async (home) => {
    // This was a module-load constant, so it pointed at ~/.codex/auth.json for
    // the life of the process no matter what the environment said.
    await fs.writeFile(
      path.join(home, "auth.json"),
      JSON.stringify({ tokens: { access_token: "token-from-custom-home" } }),
      "utf8",
    );
    assert.equal(readNativeAccessToken(), "token-from-custom-home");
  });
});

test("a missing auth file yields an empty token rather than throwing", async () => {
  await withCodexHome(() => {
    assert.equal(readNativeAccessToken(), "");
  });
});

test("no source file builds the Codex home path by hand", async () => {
  // The one permitted occurrence is the definition in paths.ts. This is a
  // source check on purpose: the failure it guards against is a *new* call
  // site being written the old way, which no behavioural test can see.
  const { readdir, readFile } = await import("node:fs/promises");
  const root = new URL("../src_v2/", import.meta.url);

  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) files.push(...(await walk(child)));
      else if (entry.name.endsWith(".ts")) files.push(child);
    }
    return files;
  };

  const offenders = [];
  for (const file of await walk(root)) {
    if (file.pathname.endsWith("/platform/paths.ts")) continue;
    const source = await readFile(file, "utf8");
    if (/homedir\(\)\s*,\s*"\.codex"/.test(source)) offenders.push(file.pathname);
  }
  assert.deepEqual(offenders, [], "use codexHomePath() instead of joining os.homedir() with .codex");
});

/**
 * Every surface that reports a version must report the same one.
 *
 * This used to hardcode the release number in four assertions, so it needed
 * hand-editing every release and still missed the bridge launcher — the one
 * binary Codex Desktop actually spawns. package.json is the single source of
 * truth now, and the test fails if any other surface drifts from it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("release surfaces agree on the runtime version", async () => {
  const { version } = JSON.parse(await read("package.json"));
  assert.match(version, /^\d+\.\d+\.\d+$/, "package.json carries the release version");

  const escaped = version.replace(/\./g, "\\.");

  for (const manifest of ["native/windows-launcher/Cargo.toml", "native/windows-bridge-launcher/Cargo.toml"]) {
    assert.match(await read(manifest), new RegExp(`^version = "${escaped}"$`, "m"), `${manifest} is stale`);
  }

  assert.match(
    await read("src_v2/server/gateway.ts"),
    new RegExp(`name: "CodexBridge Engine V2", version: "${escaped}"`),
    "the /health endpoint reports a stale version",
  );
});

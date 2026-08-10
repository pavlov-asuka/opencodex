import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("1.2.0 release surfaces agree on the runtime version", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const launcher = await readFile(new URL("../native/windows-launcher/Cargo.toml", import.meta.url), "utf8");
  const gateway = await readFile(new URL("../src_v2/server/gateway.ts", import.meta.url), "utf8");

  assert.equal(packageJson.version, "1.2.0");
  assert.match(launcher, /^version = "1\.2\.0"$/m);
  assert.match(gateway, /name: "CodexBridge Engine V2", version: "1\.2\.0"/);
});

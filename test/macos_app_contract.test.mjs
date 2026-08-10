import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("DMG uses a standard Applications drag-install layout", async () => {
  const script = await read("macos-app/scripts/package-dmg.sh");
  assert.match(script, /DMG_STAGING=/);
  assert.match(script, /cp -R "\$APP_BUNDLE" "\$DMG_STAGING\/OpenCodex\.app"/);
  assert.match(script, /ln -s \/Applications "\$DMG_STAGING\/Applications"/);
  assert.match(script, /-srcfolder "\$DMG_STAGING"/);
});

test("login startup exports the provider bridge before launching the gateway", async () => {
  const startup = await read("startup.sh");
  assert.match(startup, /launchctl setenv CODEX_CLI_PATH/);
  assert.match(startup, /launchctl setenv OPENCODEX_NATIVE_CODEX_PATH/);
  assert.match(startup, /launchctl setenv OPENCODEX_PROVIDER_BRIDGE_PATH/);
  assert.match(startup, /restart_desktop_after_gateway_ready/);
  assert.match(startup, /pm2 start \"\$PROJECT_ROOT\/dist\/server\.js\"/);
});

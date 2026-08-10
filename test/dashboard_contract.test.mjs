import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The control centre is assembled from several modules now; these contracts
// are about what the served page contains, so read the composed source.
const source = async () => {
  const parts = await Promise.all(["styles", "markup", "app", "shell", "index"].map(
    (name) => readFile(new URL(`../src_v2/services/dashboard/${name}.ts`, import.meta.url), "utf8"),
  ));
  return parts.join("\n");
};

test("dashboard keeps visible progress states for destructive and network actions", async () => {
  const text = await source();
  for (const marker of ["runButton(button,labels,task)", "测试中…", "删除中…", "保存中…", "重启中…", "refresh-logs"]) {
    assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(text, /button\.pending/);
});

test("dashboard uses the gateway admin cookie without embedding credentials", async () => {
  const text = await source();
  assert.doesNotMatch(text, /api_key.{0,20}localStorage/i);
  assert.match(text, /fetch\(/);
  assert.match(text, /api\('\/api\/providers'\)/);
});

test("dashboard exposes the per-model Chat or Responses protocol choice", async () => {
  const text = await source();
  assert.match(text, /provider-model-rows/);
  assert.match(text, /provider-model-row/);
  assert.match(text, /add-provider-model/);
  assert.match(text, /provider-remove-model/);
  assert.match(text, /多个模型用逗号分隔/);
  assert.match(text, /children\.length>=2/);
  assert.match(text, /value="chat"/);
  assert.match(text, /value="responses"/);
  assert.match(text, /provider-test-model/);
  assert.match(text, /testProviderModelRow/);
  assert.match(text, /\/api\/providers\/test-model/);
  assert.match(text, /<option value="chat"[^>]*>Chat<\/option>/);
  assert.match(text, /<option value="responses"[^>]*>Responses<\/option>/);
  assert.match(text, /model_protocols/);
  assert.match(text, /readProviderModelRows/);
});

test("dashboard exposes a persistent Chinese-English language switch", async () => {
  const text = await source();
  assert.match(text, /id="language-toggle"/);
  assert.match(text, /opencodex\.language/);
  assert.match(text, /OpenCodex Control Center/);
  assert.match(text, /setLanguage/);
  assert.match(text, /MutationObserver/);
  assert.match(text, /closest\('\.log-row'\)/);
});

test("dashboard refreshes subscription status after every model deletion path", async () => {
  const text = await source();
  assert.match(text, /post\('\/api\/models\/delete',\{id:id\}\);await syncDashboardState\(\)/);
  assert.match(text, /post\('\/api\/models\/delete',\{ids:ids\}\);await syncDashboardState\(\)/);
  assert.match(text, /post\('\/api\/providers\/delete',\{name:name\}\);await syncDashboardState\(\)/);
});

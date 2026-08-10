/**
 * Byte-exact golden file for the rendered control centre.
 *
 * Its purpose is to separate "moving code between files" from "changing what
 * the page is". While dashboard.ts is being split into modules this must not
 * shift by a single byte; when the layout is deliberately redesigned, the
 * fixture is regenerated in the same commit as the design change so the diff
 * shows exactly what moved.
 *
 * Regenerate with:
 *   node --input-type=module -e "import fs from 'node:fs'; const {getDashboardHtml}=await import('./dist/services/dashboard.js'); fs.writeFileSync('test/fixtures/dashboard.html', getDashboardHtml())"
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getDashboardHtml } from "../dist/services/dashboard/index.js";

test("the rendered dashboard matches its golden file byte for byte", async () => {
  const expected = await readFile(new URL("./fixtures/dashboard.html", import.meta.url), "utf-8");
  const actual = getDashboardHtml();

  if (actual !== expected) {
    // A 65KB diff is unreadable; point at the first divergence instead.
    const limit = Math.min(actual.length, expected.length);
    let index = 0;
    while (index < limit && actual[index] === expected[index]) index += 1;
    const line = expected.slice(0, index).split("\n").length;
    assert.fail(
      `dashboard output changed at byte ${index} (line ${line})\n` +
      `  expected: ${JSON.stringify(expected.slice(index, index + 80))}\n` +
      `  actual:   ${JSON.stringify(actual.slice(index, index + 80))}\n` +
      `  lengths:  expected ${expected.length}, actual ${actual.length}`,
    );
  }
  assert.equal(actual, expected);
});

test("the golden file is a complete document", async () => {
  const html = await readFile(new URL("./fixtures/dashboard.html", import.meta.url), "utf-8");
  // Cheap structural checks so a regenerated fixture cannot lock in a broken
  // page: the snapshot alone would happily freeze truncated output.
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/html>\s*$/);
  assert.equal((html.match(/<script>/g) || []).length, (html.match(/<\/script>/g) || []).length);
  assert.equal((html.match(/<style>/g) || []).length, (html.match(/<\/style>/g) || []).length);
  for (const view of ["view-gateway", "view-logs", "view-settings"]) {
    assert.match(html, new RegExp(`id="${view}"`));
  }
  assert.match(html, /id="api-provider-list"/);
  assert.match(html, /id="enabled-models"/);
});

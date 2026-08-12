/**
 * Batch files must use CRLF, because cmd.exe does not tolerate LF alone.
 *
 * Restore-Native-Codex.cmd shipped with LF-only endings from the first release
 * that contained it. cmd.exe mis-parsed every line — `setlocal` became `ocal`,
 * `rem` became `m` — and the script exited 255 having changed nothing: the
 * registry variables stayed, the gateway kept running, config.toml was
 * untouched. That file is the documented way out for when the gateway or the
 * bridge is what broke, so it failed in precisely the situation it exists for.
 *
 * Start-OpenCodex.cmd was LF-only too and happened to survive, which is worse
 * than failing: it made the encoding look harmless.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Every line ending in the file, classified. */
function lineEndings(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length;
  return { crlf, bareLf: lf - crlf };
}

test("batch files in the repository use CRLF", async () => {
  const scripts = (await readdir(path.join(repoRoot, "scripts")))
    .filter((name) => name.endsWith(".cmd") || name.endsWith(".bat"));
  assert.ok(scripts.length > 0, "there is at least one batch file to check");

  for (const name of scripts) {
    const text = await readFile(path.join(repoRoot, "scripts", name), "utf-8");
    const { crlf, bareLf } = lineEndings(text);
    assert.equal(bareLf, 0, `${name} has ${bareLf} LF-only line endings; cmd.exe will mis-parse it`);
    assert.ok(crlf > 0, `${name} has no line endings at all`);
  }
});

test("the packaging step emits CRLF whatever the checkout did", async () => {
  // The source of the launcher is a template literal in the packaging script,
  // so it is LF by construction and has to be converted at write time. A
  // .gitattributes rule alone would not cover it.
  const source = await readFile(path.join(repoRoot, "scripts", "package-windows.mjs"), "utf-8");
  assert.match(source, /replace\(\/\\r\?\\n\/g, "\\r\\n"\)/, "the staging step must normalise line endings");

  for (const name of ["Start-OpenCodex.cmd", "Restore-Native-Codex.cmd"]) {
    assert.ok(source.includes(name), `${name} must still be produced by the packaging step`);
  }
});

test("the escape hatch does not touch the user's own config keys", async () => {
  // The cleaning step is inline PowerShell inside the .cmd. It used to delete
  // every model_catalog_json line unconditionally — the same defect that was
  // fixed in the gateway's own reset path but never carried across to the
  // standalone script, which is the copy that runs when the gateway is broken.
  const script = await readFile(path.join(repoRoot, "scripts", "restore-native-codex.cmd"), "utf-8");

  assert.match(script, /model_catalog_json[\s\S]{0,200}\\\.opencodex/, "catalog removal must be scoped to ours");
  assert.match(script, /openai_base_url[\s\S]{0,200}127\\\.0\\\.0\\\.1/, "base URL removal must be scoped to loopback");
  assert.doesNotMatch(
    script,
    /Get-Process -Name 'Codex','ChatGPT'/,
    "killing by image name takes a separate ChatGPT install with it",
  );
  assert.match(script, /WindowsApps\\OpenAI\./, "process termination must be scoped by install location");
  assert.match(script, /PackageFamilyName/, "the relaunch must resolve the package, not hardcode one machine's PFN");
});

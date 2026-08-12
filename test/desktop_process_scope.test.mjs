/**
 * Restarting Desktop must not force-kill processes OpenCodex does not own.
 *
 * stopDesktopClients() ran `taskkill /F /T /IM` over a fixed list of image
 * names that included ChatGPT.exe — every matching process on the machine,
 * whoever started it. A user with a separate ChatGPT install, a second Codex
 * window, or unsaved work in either lost it whenever OpenCodex restarted
 * Desktop. Ownership is now decided by where the executable lives.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const isWindows = process.platform === "win32";
const load = async () => (await import("../dist/platform/win32.js")).isManagedDesktopProcess;

const proc = (name, executablePath, processId = 4242) => ({
  name,
  executablePath,
  processId,
  commandLine: `"${executablePath}" app-server`,
});

test("a Desktop process inside the managed install is ours", { skip: !isWindows }, async () => {
  const isManaged = await load();
  const roots = [path.resolve("C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64__abc").toLowerCase()];

  assert.equal(
    isManaged(proc("ChatGPT.exe", "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64__abc\\app\\ChatGPT.exe"), roots),
    true,
  );
});

test("the same image name from another install is not", { skip: !isWindows }, async () => {
  const isManaged = await load();
  const roots = [path.resolve("C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64__abc").toLowerCase()];

  // The exact case the old code destroyed: a plain ChatGPT desktop app the
  // user installed themselves, unrelated to Codex or OpenCodex.
  assert.equal(isManaged(proc("ChatGPT.exe", "C:\\Users\\me\\AppData\\Local\\ChatGPT\\ChatGPT.exe"), roots), false);
  assert.equal(isManaged(proc("Codex.exe", "D:\\some-other-place\\Codex.exe"), roots), false);
});

test("a sibling directory with a shared prefix is not inside the root", { skip: !isWindows }, async () => {
  const isManaged = await load();
  const roots = [path.resolve("C:\\apps\\codex").toLowerCase()];
  assert.equal(isManaged(proc("Codex.exe", "C:\\apps\\codex-backup\\Codex.exe"), roots), false);
  assert.equal(isManaged(proc("Codex.exe", "C:\\apps\\codex\\Codex.exe"), roots), true);
});

test("OpenCodex's own staged binaries are ours even without an executable path", { skip: !isWindows }, async () => {
  const isManaged = await load();
  // Win32_Process leaves ExecutablePath empty when it cannot read it.
  assert.equal(isManaged(proc("codex-provider-bridge.exe", ""), []), true);
  assert.equal(isManaged(proc("codex-code-mode-host.exe", ""), []), true);
  assert.equal(isManaged(proc("ChatGPT.exe", ""), []), false, "an unreadable path is not a licence to kill");
});

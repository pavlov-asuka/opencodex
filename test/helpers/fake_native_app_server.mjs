import { chmod, copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const windowsLauncher = fileURLToPath(new URL("../../dist/codex-provider-bridge.exe", import.meta.url));

/**
 * Materialise the fake native app-server the provider bridge will spawn.
 *
 * The bridge starts the native binary with `child_process.spawn` and no shell,
 * exactly as Codex Desktop starts the bridge itself. On POSIX a `#!` script is
 * therefore enough, but Windows cannot execute one: `CreateProcess` has no
 * shebang handling and Node refuses `.cmd` targets without a shell.
 *
 * The Windows bridge launcher resolves `<own-name>.mjs` next to itself, so a
 * copy of it named after the fake script becomes a real PE entry point for that
 * script — which is what lets these protocol tests run on Windows at all.
 *
 * @returns the path to hand to `OPENCODEX_NATIVE_CODEX_PATH`.
 */
export async function writeFakeNativeAppServer(tempRoot, source, baseName = "fake-native-app-server") {
  const scriptPath = join(tempRoot, `${baseName}.mjs`);
  await writeFile(scriptPath, source, "utf8");

  if (process.platform !== "win32") {
    await chmod(scriptPath, 0o755);
    return scriptPath;
  }

  if (!existsSync(windowsLauncher)) {
    throw new Error(
      "dist/codex-provider-bridge.exe is missing; run `npm run build:windows` before the provider split tests",
    );
  }
  const executablePath = join(tempRoot, `${baseName}.exe`);
  await copyFile(windowsLauncher, executablePath);
  return executablePath;
}

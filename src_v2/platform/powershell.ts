/**
 * Windows PowerShell helper.
 *
 * Windows PowerShell 5.1 is used deliberately rather than `pwsh`: it ships with
 * every supported Windows version, and it carries `System.Security` in the box,
 * which PowerShell 7 does not (there `ProtectedData` lives in a separate
 * package that may be absent).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 20000;

export function powerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(candidate) ? candidate : "powershell.exe";
}

/**
 * Run a PowerShell script and return stdout.
 *
 * `input` is written to the script's stdin. Secrets must always be passed that
 * way: an argument would otherwise be readable by any process that can query
 * `Win32_Process.CommandLine`.
 */
export function runPowerShell(script: string, options: { timeout?: number; input?: string } = {}): string {
  return execFileSync(
    powerShellExecutable(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf-8",
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      input: options.input,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      windowsHide: true,
    },
  ).trim();
}

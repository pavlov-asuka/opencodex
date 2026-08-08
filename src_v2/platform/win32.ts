/**
 * Windows Desktop controller.
 *
 * The Windows Codex Desktop client is an MSIX (Desktop Bridge) package, which
 * changes every assumption the macOS path makes:
 *
 *   - There is no `launchctl setenv`. The session-wide equivalent is
 *     `HKCU\Environment` plus a `WM_SETTINGCHANGE` broadcast; MSIX activation
 *     builds a new process environment from that key, so Desktop inherits the
 *     bridge variables no matter how the user starts it.
 *   - There is no `.app` bundle. The executable lives under the ACL-locked
 *     `%ProgramFiles%\WindowsApps\OpenAI.Codex_*` and is normally started
 *     through shell activation (`shell:AppsFolder\<PFN>!<AppId>`) so the app
 *     keeps its package identity.
 *   - The app resolves its app-server through `CODEX_CLI_PATH` first and only
 *     validates `existsSync` + `isFile`, then spawns it with
 *     `child_process.spawn` and no shell. A `.cmd` shim would be rejected by
 *     Node's Windows batch-file guard, so the bridge launcher must be a real
 *     PE executable (see `native/windows-bridge-launcher`).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { bridgeEnvironmentValues, codexConfigPath, codexHomePath, BRIDGE_ENVIRONMENT_VARIABLES } from "./paths.js";
import { runPowerShell } from "./powershell.js";
import type { DesktopAppServerState, DesktopController } from "./types.js";

/** Image names to terminate when restarting the Desktop client. */
const DESKTOP_IMAGE_NAMES = [
  "ChatGPT.exe",
  "Codex.exe",
  "ChatGPT Classic.exe",
  "codex.exe",
  "codex-provider-bridge.exe",
  "codex-code-mode-host.exe",
];

/** MSIX package names that can host the Codex Desktop client, best first. */
const DESKTOP_PACKAGE_NAMES = ["OpenAI.Codex", "OpenAI.ChatGPT-Desktop"];

const DISCOVERY_CACHE_TTL_MS = 60_000;

type PackageInfo = {
  packageFamilyName: string;
  installLocation: string;
  applicationId: string;
  executable: string;
};

let cachedPackage: { at: number; value: PackageInfo | null } | null = null;

function isFile(candidate: string): boolean {
  try { return Boolean(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile(); } catch { return false; }
}

/** Newest-first subdirectories, used for the hashed Codex runtime folders. */
function subdirectoriesByRecency(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .map((dir) => ({ dir, at: (() => { try { return fs.statSync(dir).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => b.at - a.at)
      .map((entry) => entry.dir);
  } catch {
    return [];
  }
}

/**
 * Resolve the installed Desktop MSIX package.
 *
 * `Get-AppxPackage` is authoritative but costs roughly a second, so the result
 * is cached briefly. A direct scan of `WindowsApps` is kept as a fallback for
 * machines where the AppX cmdlets are unavailable.
 */
function desktopPackage(): PackageInfo | null {
  if (cachedPackage && Date.now() - cachedPackage.at < DISCOVERY_CACHE_TTL_MS) return cachedPackage.value;
  const resolved = resolveDesktopPackage();
  cachedPackage = { at: Date.now(), value: resolved };
  return resolved;
}

function resolveDesktopPackage(): PackageInfo | null {
  for (const name of DESKTOP_PACKAGE_NAMES) {
    try {
      const raw = runPowerShell(
        `$p = Get-AppxPackage -Name '${name}' | Select-Object -First 1; ` +
        `if ($null -eq $p) { exit 0 }; ` +
        `$m = [xml](Get-Content -LiteralPath (Join-Path $p.InstallLocation 'AppxManifest.xml') -Raw); ` +
        `$a = @($m.Package.Applications.Application)[0]; ` +
        `[Console]::Out.Write((ConvertTo-Json -Compress ([ordered]@{ pfn = $p.PackageFamilyName; loc = $p.InstallLocation; id = $a.Id; exe = $a.Executable })))`,
      );
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { pfn?: string; loc?: string; id?: string; exe?: string };
      const installLocation = String(parsed.loc || "").trim();
      const relative = String(parsed.exe || "").trim().replace(/\//g, "\\");
      if (!installLocation || !relative) continue;
      const executable = path.join(installLocation, relative);
      if (!isFile(executable)) continue;
      return {
        packageFamilyName: String(parsed.pfn || "").trim(),
        installLocation,
        applicationId: String(parsed.id || "App").trim() || "App",
        executable,
      };
    } catch {}
  }
  return scanWindowsAppsForDesktop();
}

function scanWindowsAppsForDesktop(): PackageInfo | null {
  const root = path.join(process.env.ProgramFiles || "C:\\Program Files", "WindowsApps");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const packageName of DESKTOP_PACKAGE_NAMES) {
    const matches = entries
      .filter((entry) => entry.startsWith(`${packageName}_`) && entry.includes("_x64__"))
      .sort()
      .reverse();
    for (const match of matches) {
      const installLocation = path.join(root, match);
      for (const relative of ["app\\ChatGPT.exe", "app\\ChatGPT Classic.exe", "app\\Codex.exe"]) {
        const executable = path.join(installLocation, relative);
        if (!isFile(executable)) continue;
        const family = match.split("_");
        const packageFamilyName = family.length >= 2 ? `${family[0]}_${family[family.length - 1]}` : "";
        return { packageFamilyName, installLocation, applicationId: "App", executable };
      }
    }
  }
  return null;
}

/** JSON snapshot of running Codex-related processes and their command lines. */
function runningCodexProcesses(): Array<{ name: string; commandLine: string }> {
  try {
    const raw = runPowerShell(
      "$r = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.Name -like 'codex*' -or $_.Name -like 'ChatGPT*' } | " +
      "ForEach-Object { [ordered]@{ name = $_.Name; commandLine = ($_.CommandLine -as [string]) } }); " +
      "[Console]::Out.Write((ConvertTo-Json -Compress -Depth 3 @($r)))",
    );
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter(Boolean)
      .map((entry: any) => ({ name: String(entry?.name || ""), commandLine: String(entry?.commandLine || "") }));
  } catch {
    return [];
  }
}

function broadcastEnvironmentChange(): void {
  try {
    runPowerShell(
      "if (-not ('OpenCodexEnvBroadcast' -as [type])) { Add-Type -Namespace Win32 -Name OpenCodexEnvBroadcast -MemberDefinition '" +
      "[DllImport(\"user32.dll\", SetLastError = true, CharSet = CharSet.Auto)] " +
      "public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);' }; " +
      "$r = [UIntPtr]::Zero; " +
      "[void][Win32.OpenCodexEnvBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)",
    );
  } catch (error: any) {
    console.warn(`[OpenCodex Gateway] Environment broadcast failed; a sign-out may be needed for Start-menu launches: ${error?.message || error}`);
  }
}

function writeUserEnvironmentValue(name: string, value: string): void {
  execFileSync("reg", ["add", "HKCU\\Environment", "/v", name, "/t", "REG_SZ", "/d", value, "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function deleteUserEnvironmentValue(name: string): void {
  try {
    execFileSync("reg", ["delete", "HKCU\\Environment", "/v", name, "/f"], { stdio: "ignore", windowsHide: true });
  } catch {
    // A missing value exits non-zero; that is the desired end state anyway.
  }
}

export const win32DesktopController: DesktopController = {
  platform: "win32",

  providerBridgePath(): string {
    const configured = String(process.env.OPENCODEX_PROVIDER_BRIDGE_PATH || "").trim();
    const candidates = [
      configured,
      path.join(process.cwd(), "dist", "codex-provider-bridge.exe"),
      path.join(process.cwd(), "codex-provider-bridge.exe"),
      path.join(path.dirname(process.execPath), "codex-provider-bridge.exe"),
      path.join(path.dirname(process.execPath), "resources", "codex-provider-bridge.exe"),
    ].filter(Boolean);
    return candidates.find(isFile) || "";
  },

  nativeCodexExecutablePath(): string {
    const configured = String(process.env.OPENCODEX_NATIVE_CODEX_PATH || "").trim();
    if (isFile(configured)) return configured;

    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
    const candidates: string[] = [
      // What the Desktop client itself executes: it copies the CLI out of the
      // read-only MSIX into this user-writable directory on every launch, so it
      // always matches the installed app version.
      path.join(codexHomePath(), "plugins", ".plugin-appserver", "codex.exe"),
    ];

    // Hashed runtime folders, newest first.
    for (const dir of subdirectoriesByRecency(path.join(localAppData, "OpenAI", "Codex", "bin"))) {
      candidates.push(path.join(dir, "codex.exe"));
    }

    // The MSIX payload itself, then the pre-MSIX install layouts.
    const installed = desktopPackage();
    if (installed?.installLocation) {
      candidates.push(path.join(installed.installLocation, "app", "resources", "codex.exe"));
    }
    candidates.push(
      path.join(localAppData, "Programs", "Codex", "resources", "codex.exe"),
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Codex", "resources", "codex.exe"),
      path.join(localAppData, "Programs", "Codex", "Codex.exe"),
    );

    const bridge = this.providerBridgePath();
    // Never delegate to ourselves: that would make the bridge spawn the bridge.
    return candidates.find((candidate) => isFile(candidate) && path.resolve(candidate) !== path.resolve(bridge || "\0")) || "";
  },

  desktopApplicationExecutable(): string {
    const configured = String(process.env.OPENCODEX_DESKTOP_APP_PATH || "").trim();
    if (isFile(configured)) return configured;
    return desktopPackage()?.executable || "";
  },

  desktopAppServerState(): DesktopAppServerState {
    const processes = runningCodexProcesses();
    const appServers = processes.filter((entry) => /app-server/i.test(entry.commandLine));
    if (appServers.some((entry) => /codex-provider-bridge/i.test(`${entry.name} ${entry.commandLine}`))) return "bridge";
    if (appServers.length > 0) return "native";
    return "absent";
  },

  stopDesktopClients(): void {
    for (const image of DESKTOP_IMAGE_NAMES) {
      try {
        execFileSync("taskkill", ["/F", "/T", "/IM", image], { stdio: "ignore", windowsHide: true });
      } catch {
        // taskkill exits non-zero when the image is not running.
      }
    }
  },

  launchDesktopClient(launchWithCdp: boolean): void {
    if (!launchWithCdp) return;

    const bridge = this.providerBridgePath();
    const nativeCodex = this.nativeCodexExecutablePath();
    const installed = desktopPackage();
    const appExecutable = this.desktopApplicationExecutable();

    // Refuse an unbridged launch while a managed catalog is active: Desktop
    // would send a third-party slug to the official ChatGPT account, which is
    // exactly the user-visible "model is not supported" failure.
    let managed = false;
    try { managed = fs.readFileSync(codexConfigPath(), "utf-8").includes("opencodex managed"); } catch {}
    if (managed && (!bridge || !nativeCodex)) {
      console.warn("[OpenCodex Gateway] Managed third-party routing is active but the provider bridge is unavailable; refusing an unbridged Desktop launch.");
      return;
    }

    const port = Number.parseInt(process.env.OPENCODEX_GATEWAY_PORT || process.env.OPENCODEX_PORT || "8765", 10) || 8765;
    const bridgeEnvironment = bridge && nativeCodex ? bridgeEnvironmentValues(bridge, nativeCodex, port) : {};
    const mode = String(process.env.OPENCODEX_WINDOWS_LAUNCH_MODE || "shell").trim().toLowerCase();

    // Shell activation keeps the MSIX package identity the app depends on. The
    // bridge variables reach it through HKCU\Environment, which the activation
    // path expands into the new process environment.
    if (mode !== "direct" && installed?.packageFamilyName) {
      try {
        const target = `shell:AppsFolder\\${installed.packageFamilyName}!${installed.applicationId}`;
        const child = spawn("explorer.exe", [target], { detached: true, stdio: "ignore", windowsHide: true });
        child.once("error", (error) => {
          console.warn(`[OpenCodex Gateway] Desktop shell activation failed: ${error?.message || error}`);
        });
        child.unref();
        console.log(`[OpenCodex Gateway] Activated Desktop through the shell with provider bridge: ${bridge || "(unavailable)"}`);
        return;
      } catch (error: any) {
        console.warn(`[OpenCodex Gateway] Desktop shell activation failed; falling back to a direct launch: ${error?.message || error}`);
      }
    }

    // Direct launch guarantees the environment block but drops package
    // identity, so it is the fallback rather than the default.
    if (appExecutable) {
      try {
        const child = spawn(appExecutable, ["--remote-debugging-port=8315"], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: { ...process.env, ...bridgeEnvironment },
        });
        child.once("error", (error) => {
          console.warn(`[OpenCodex Gateway] Provider bridge desktop launch failed: ${error?.message || error}`);
        });
        child.unref();
        console.log(`[OpenCodex Gateway] Launched Desktop directly with provider bridge: ${bridge || "(unavailable)"}`);
        return;
      } catch (error: any) {
        console.warn(`[OpenCodex Gateway] Provider bridge launch failed; keeping native-only desktop fallback: ${error?.message || error}`);
      }
    }

    console.warn("[OpenCodex Gateway] Could not locate the Codex Desktop client; start it manually to pick up the provider bridge.");
  },

  registerProviderBridgeEnvironment(port: number): boolean {
    const bridge = this.providerBridgePath();
    const nativeCodex = this.nativeCodexExecutablePath();
    if (!bridge || !nativeCodex) {
      console.warn("[OpenCodex Gateway] Provider bridge startup skipped: bridge or native Codex executable is unavailable.");
      return false;
    }
    const values = bridgeEnvironmentValues(bridge, nativeCodex, port);
    try {
      for (const [name, value] of Object.entries(values)) {
        writeUserEnvironmentValue(name, value);
        // Keep this process aligned so anything the gateway spawns itself
        // inherits the same routing without waiting for the broadcast.
        process.env[name] = value;
      }
    } catch (error: any) {
      console.warn(`[OpenCodex Gateway] Could not register provider bridge in the user environment: ${error?.message || error}`);
      return false;
    }
    broadcastEnvironmentChange();
    console.log(`[OpenCodex Gateway] Provider bridge registered for gateway lifecycle: ${bridge}`);
    return true;
  },

  unregisterProviderBridgeEnvironment(): void {
    for (const variable of BRIDGE_ENVIRONMENT_VARIABLES) {
      deleteUserEnvironmentValue(variable);
      delete process.env[variable];
    }
    broadcastEnvironmentChange();
    // This only affects future Desktop launches. The already-running Desktop
    // and its provider bridge remain open, so native GPT can keep using the
    // official path while third-party requests fail closed until the gateway
    // is started again.
    console.log("[OpenCodex Gateway] Provider bridge detached from future launches; existing Desktop was left running.");
  },
};

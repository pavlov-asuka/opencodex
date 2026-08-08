/**
 * macOS Desktop controller.
 *
 * Behaviour is unchanged from the inline implementation that used to live in
 * `server/gateway.ts`; it was moved here so Windows can supply an equivalent
 * without either platform growing `process.platform` branches.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { bridgeEnvironmentValues, codexConfigPath, BRIDGE_ENVIRONMENT_VARIABLES } from "./paths.js";
import type { DesktopAppServerState, DesktopController } from "./types.js";

const DESKTOP_PROCESS_NAMES = [
  "ChatGPT", "Codex", "Codex (Service)", "bare-modifier-monitor",
  "browser_crashpad_handler", "Codex Helper", "Codex Helper (Renderer)",
  "Codex Helper (GPU)", "SkyComputerUseClient", "SkyComputerUseService"
];

function desktopBundleExecutable(bundlePath: string): string {
  const candidates: string[] = [];
  const plistPath = path.join(bundlePath, "Contents", "Info.plist");
  try {
    const executable = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plistPath], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (executable) candidates.push(executable);
  } catch {}
  try {
    const plist = fs.readFileSync(plistPath, "utf-8");
    const match = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/i);
    if (match?.[1]) candidates.push(match[1].trim());
  } catch {}

  const bundleName = path.basename(bundlePath, ".app");
  candidates.push(bundleName, "ChatGPT", "Codex");
  for (const name of candidates) {
    const executable = path.join(bundlePath, "Contents", "MacOS", name);
    try {
      if (fs.existsSync(executable) && fs.statSync(executable).isFile()) return executable;
    } catch {}
  }
  return "";
}

export const darwinDesktopController: DesktopController = {
  platform: "darwin",

  providerBridgePath(): string {
    const configured = String(process.env.OPENCODEX_PROVIDER_BRIDGE_PATH || "").trim();
    const candidates = [
      configured,
      path.join(process.cwd(), "dist", "codex-provider-bridge"),
      path.join(process.cwd(), "codex-provider-bridge"),
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || "";
  },

  nativeCodexExecutablePath(): string {
    const configured = String(process.env.OPENCODEX_NATIVE_CODEX_PATH || "").trim();
    const candidates = [
      configured,
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || "";
  },

  desktopApplicationExecutable(): string {
    const bundles = [
      "/Applications/ChatGPT.app",
      "/Applications/Codex.app",
    ];
    for (const bundle of bundles) {
      const executable = desktopBundleExecutable(bundle);
      if (executable) return executable;
    }
    return "";
  },

  desktopAppServerState(): DesktopAppServerState {
    try {
      execFileSync("pgrep", ["-f", "codex-provider-bridge.*app-server"], { stdio: "ignore" });
      return "bridge";
    } catch {}
    try {
      execFileSync("pgrep", ["-f", "/Applications/(ChatGPT|Codex)\\.app/Contents/Resources/codex.*app-server"], { stdio: "ignore" });
      return "native";
    } catch {}
    return "absent";
  },

  stopDesktopClients(): void {
    for (const processName of DESKTOP_PROCESS_NAMES) {
      try { execFileSync("killall", ["-9", processName], { stdio: "ignore" }); } catch {}
    }
    try { execFileSync("pkill", ["-TERM", "-f", "[c]odex.*app-server"], { stdio: "ignore" }); } catch {}
    try { execFileSync("pkill", ["-TERM", "-f", "[c]odex-provider-bridge.*app-server"], { stdio: "ignore" }); } catch {}
    try { execFileSync("sleep", ["0.8"], { stdio: "ignore" }); } catch {}
    try { execFileSync("pkill", ["-KILL", "-f", "[c]odex.*app-server"], { stdio: "ignore" }); } catch {}
    try { execFileSync("pkill", ["-KILL", "-f", "[c]odex-provider-bridge.*app-server"], { stdio: "ignore" }); } catch {}
  },

  launchDesktopClient(launchWithCdp: boolean): void {
    if (!launchWithCdp) return;

    const bridge = this.providerBridgePath();
    const nativeCodex = this.nativeCodexExecutablePath();
    const appExecutable = this.desktopApplicationExecutable();
    if (bridge && nativeCodex && appExecutable) {
      try {
        const port = Number.parseInt(process.env.OPENCODEX_GATEWAY_PORT || process.env.OPENCODEX_PORT || "8765", 10) || 8765;
        const child = spawn(appExecutable, ["--remote-debugging-port=8315"], {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            ...bridgeEnvironmentValues(bridge, nativeCodex, port),
          },
        });
        child.once("error", (error) => {
          console.warn(`[OpenCodex Gateway] Provider bridge desktop launch failed: ${error?.message || error}`);
        });
        child.unref();
        console.log(`[OpenCodex Gateway] Launched Desktop with provider bridge: ${bridge}`);
        return;
      } catch (error: any) {
        console.warn(`[OpenCodex Gateway] Provider bridge launch failed; keeping native-only desktop fallback: ${error?.message || error}`);
      }
    }

    // LaunchServices does not reliably inherit CODEX_CLI_PATH. If a managed
    // provider catalog exists, opening the app without a complete bridge would
    // send a third-party slug to the native ChatGPT account and reproduce the
    // user-visible unsupported-model error. Refuse that unsafe fallback.
    const configPath = codexConfigPath();
    let managed = false;
    try { managed = fs.readFileSync(configPath, "utf-8").includes("opencodex managed"); } catch {}
    if (managed && (!bridge || !nativeCodex || !appExecutable)) {
      console.warn("[OpenCodex Gateway] Managed third-party routing is active but the provider bridge is unavailable; refusing an unbridged Desktop launch.");
      return;
    }

    for (const application of ["ChatGPT", "Codex"]) {
      try {
        execFileSync("open", ["-a", application, "--args", "--remote-debugging-port=8315"], { stdio: "ignore" });
        if (!bridge || !nativeCodex) {
          console.warn("[OpenCodex Gateway] Desktop provider bridge is unavailable; native GPT remains direct, while third-party models wait for the bridge and gateway.");
        }
        return;
      } catch {}
    }
  },

  registerProviderBridgeEnvironment(port: number): boolean {
    const bridge = this.providerBridgePath();
    const nativeCodex = this.nativeCodexExecutablePath();
    if (!bridge || !nativeCodex) {
      console.warn("[OpenCodex Gateway] Provider bridge startup skipped: bridge or native Codex executable is unavailable.");
      return false;
    }
    try {
      // Keep the bridge lifecycle owned by the gateway itself. This covers a
      // direct `pm2 start opencodex` as well as the login/DMG startup paths.
      for (const [name, value] of Object.entries(bridgeEnvironmentValues(bridge, nativeCodex, port))) {
        execFileSync("/bin/launchctl", ["setenv", name, value], { stdio: "ignore" });
      }
      console.log(`[OpenCodex Gateway] Provider bridge registered for gateway lifecycle: ${bridge}`);
      return true;
    } catch (error: any) {
      console.warn(`[OpenCodex Gateway] Could not register provider bridge with launchd: ${error?.message || error}`);
      return false;
    }
  },

  unregisterProviderBridgeEnvironment(): void {
    for (const variable of BRIDGE_ENVIRONMENT_VARIABLES) {
      try { execFileSync("/bin/launchctl", ["unsetenv", variable], { stdio: "ignore" }); } catch {}
    }
    // This only affects future Desktop launches. The already-running Desktop
    // and its provider bridge remain open, so native GPT can keep using the
    // official path while third-party requests fail closed until the gateway
    // is started again.
    console.log("[OpenCodex Gateway] Provider bridge detached from future launches; existing Desktop was left running.");
  },
};

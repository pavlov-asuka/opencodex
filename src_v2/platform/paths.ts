/**
 * Shared filesystem locations for the Codex install.
 *
 * This lives outside `server/gateway.ts` so the platform controllers can reach
 * it without importing the gateway module back (which would be circular).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function codexHomePath(): string {
  const configured = String(process.env.CODEX_HOME || "").trim();
  return configured || path.join(os.homedir(), ".codex");
}

export function codexConfigPath(): string {
  const configured = String(process.env.OPENCODEX_CODEX_CONFIG_PATH || "").trim();
  return configured || path.join(codexHomePath(), "config.toml");
}

/**
 * Environment variables the Desktop client needs in order to route third-party
 * turns through the provider bridge. `CODEX_CLI_PATH` is the one the Codex
 * Electron app actually reads when it resolves the app-server binary; the
 * `OPENCODEX_*` entries are consumed by the bridge process itself.
 */
export const BRIDGE_ENVIRONMENT_VARIABLES = [
  "CODEX_CLI_PATH",
  "OPENCODEX_NATIVE_CODEX_PATH",
  "OPENCODEX_PROVIDER_BRIDGE_PATH",
  "OPENCODEX_PROVIDER_SPLIT",
  "OPENCODEX_GATEWAY_PORT",
  "OPENCODEX_NATIVE_EGRESS",
] as const;

/** Where the setting that decides official-model routing is kept. */
export function nativeEgressSettingPath(dataDir?: string): string {
  return path.join(dataDir || path.join(os.homedir(), ".opencodex"), "native-egress.json");
}

/**
 * Should the bridge intercept official ChatGPT traffic?
 *
 * On, the native runtime is pointed at the bridge's local egress router, which
 * is the only way a Codex-spawned subagent can be handed to a third-party
 * model. Off, official turns go straight to chatgpt.com and nothing in this
 * project can affect them — at the cost of third-party subagents.
 */
export function nativeEgressEnabled(dataDir?: string): boolean {
  const override = String(process.env.OPENCODEX_NATIVE_EGRESS ?? "").trim().toLowerCase();
  if (override) return !["0", "false", "off", "no"].includes(override);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const raw = require("node:fs").readFileSync(nativeEgressSettingPath(dataDir), "utf-8");
    return JSON.parse(raw)?.enabled !== false;
  } catch {
    return true;
  }
}

export function bridgeEnvironmentValues(bridge: string, nativeCodex: string, port: number): Record<string, string> {
  return {
    CODEX_CLI_PATH: bridge,
    OPENCODEX_NATIVE_CODEX_PATH: nativeCodex,
    OPENCODEX_PROVIDER_BRIDGE_PATH: bridge,
    OPENCODEX_PROVIDER_SPLIT: "1",
    OPENCODEX_GATEWAY_PORT: String(Number.isInteger(port) && port > 0 ? port : 8765),
    OPENCODEX_NATIVE_EGRESS: nativeEgressEnabled() ? "1" : "0",
  };
}

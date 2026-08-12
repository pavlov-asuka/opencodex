/**
 * Shared filesystem locations for the Codex install.
 *
 * This lives outside `server/gateway.ts` so the platform controllers can reach
 * it without importing the gateway module back (which would be circular).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../core/atomic_write.js";

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

/** The OpenCodex runtime directory, honouring an explicit override. */
export function openCodexDataDir(dataDir?: string): string {
  const configured = String(dataDir || process.env.OPENCODEX_DATA_DIR || "").trim();
  return configured || path.join(os.homedir(), ".opencodex");
}

/**
 * The imported model catalog Codex reads.
 *
 * Resolved per call. Fifteen call sites used to build this from os.homedir()
 * directly, so OPENCODEX_DATA_DIR was honoured for providers.json and the
 * routing setting but silently ignored for the catalog — the gateway wrote its
 * providers to one directory and read its models from another.
 */
export function openCodexCatalogPath(dataDir?: string): string {
  return path.join(openCodexDataDir(dataDir), "custom_model_catalog.json");
}

/** Where the setting that decides official-model routing is kept. */
export function nativeEgressSettingPath(dataDir?: string): string {
  return path.join(openCodexDataDir(dataDir), "native-egress.json");
}

/**
 * The user's explicit environment override, if they set one.
 *
 * `undefined` means "not specified" — distinct from `false`. Only a human
 * editing their environment should reach this; see the note on
 * `nativeEgressForPublishing` for why the gateway must not.
 */
export function nativeEgressUserOverride(): boolean | undefined {
  const raw = String(process.env.OPENCODEX_NATIVE_EGRESS ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  return !["0", "false", "off", "no"].includes(raw);
}

/**
 * The persisted setting, which the dashboard toggle writes. Absent means on.
 */
export function nativeEgressSetting(dataDir?: string): boolean {
  try {
    // Previously `require("node:fs")` — undefined in an ESM module, so this
    // threw on every call, the empty catch swallowed it, and the function
    // always returned true. The file had never once been read.
    const raw = fs.readFileSync(nativeEgressSettingPath(dataDir), "utf-8");
    return JSON.parse(raw)?.enabled !== false;
  } catch {
    return true;
  }
}

/**
 * Should the bridge intercept official ChatGPT traffic?
 *
 * On, the native runtime is pointed at the bridge's local egress router, which
 * is the only way a Codex-spawned subagent can be handed to a third-party
 * model. Off, official turns go straight to chatgpt.com and nothing in this
 * project can affect them — at the cost of third-party subagents.
 *
 * This is the consumer's view, used by the bridge: an explicit environment
 * override wins, otherwise the stored setting decides.
 */
export function nativeEgressEnabled(dataDir?: string): boolean {
  return nativeEgressUserOverride() ?? nativeEgressSetting(dataDir);
}

/**
 * The value the gateway publishes to the environment — the stored setting and
 * nothing else.
 *
 * The distinction from `nativeEgressEnabled` is the whole fix. Registration
 * writes OPENCODEX_NATIVE_EGRESS into both HKCU and this process's own
 * `process.env`. When the published value was computed by reading that same
 * variable, the first "1" latched forever: turning the dashboard toggle off
 * wrote `enabled: false` to disk, then republished "1" over it. The producer
 * must never consult its own output.
 */
export function nativeEgressForPublishing(dataDir?: string): boolean {
  return nativeEgressSetting(dataDir);
}

export function bridgeEnvironmentValues(
  bridge: string,
  nativeCodex: string,
  port: number,
  nativeEgress: boolean = nativeEgressForPublishing(),
): Record<string, string> {
  return {
    CODEX_CLI_PATH: bridge,
    OPENCODEX_NATIVE_CODEX_PATH: nativeCodex,
    OPENCODEX_PROVIDER_BRIDGE_PATH: bridge,
    OPENCODEX_PROVIDER_SPLIT: "1",
    OPENCODEX_GATEWAY_PORT: String(Number.isInteger(port) && port > 0 ? port : 8765),
    OPENCODEX_NATIVE_EGRESS: nativeEgress ? "1" : "0",
  };
}

/**
 * Adopt a hand-set environment override into the stored setting, once.
 *
 * Keeps `OPENCODEX_NATIVE_EGRESS=0` working as an escape hatch for someone
 * whose dashboard is unreachable: set it, restart the gateway, and the choice
 * becomes the stored setting. Without this the gateway would publish the file
 * value straight back over the value the user had just set by hand.
 *
 * A no-op in the ordinary case, because the inherited value came from the file
 * in the first place.
 */
export function adoptNativeEgressOverride(dataDir?: string): void {
  const override = nativeEgressUserOverride();
  if (override === undefined || override === nativeEgressSetting(dataDir)) return;
  writeJsonAtomic(nativeEgressSettingPath(dataDir), { enabled: override });
  console.log(`[OpenCodex Gateway] Adopted OPENCODEX_NATIVE_EGRESS=${override ? "1" : "0"} from the environment.`);
}

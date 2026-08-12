/**
 * CodexBridge Gateway Server (OpenCodex V2 Core)
 * Ultra-clean, modular HTTP Gateway Server listening on port 8765.
 */

import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { GatewayRouter, type GatewaySubagentDispatchCall, type GatewaySubagentDispatchContext, type GatewaySubagentDispatchResult } from "./router.js";
import { clearProviderModelSelections, CredentialStore } from "../services/credential_store.js";
import { RequestDecompressor } from "../core/decompressor.js";
import { applyDefaultReasoningCapabilities, CatalogSyncService, buildFullCatalogEntry, getDefaultReasoningPresets } from "../services/catalog_sync.js";
import { copyNativeRequestHeaders } from "./native_headers.js";
import { ProviderConfig } from "../core/types.js";
import { isNativeResponsesReasoningId } from "../core/responses_safety.js";
import { closeUpstreamDispatcher, fetchUpstream, upstreamErrorDetails } from "../services/upstream_fetch.js";
import { copySafeResponseHeaders, writeHttpResponseChunked, writeSseData } from "../services/http_stream.js";
import { TaskRouter } from "../services/task_router.js";
import { SubagentOrchestrator } from "../services/subagent_orchestrator.js";
import { agentMessageOracleEnabled, hasEncryptedAgentMessage, resolveEncryptedAgentMessages } from "../services/agent_message_oracle.js";
import {
  codexConfigPath,
  codexHomePath,
  desktopController,
  nativeCodexExecutablePath,
  providerBridgePath,
} from "../platform/index.js";
import type { DesktopController } from "../platform/index.js";
import { adoptNativeEgressOverride, nativeEgressEnabled, nativeEgressSettingPath } from "../platform/paths.js";

// Re-exported so existing importers (catalog_sync) keep their entry point.
export { codexConfigPath };

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MASKED_CREDENTIAL = "••••••••";
type ModelProtocol = "chat" | "responses";

function isResponsesCompactionPath(pathname: string): boolean {
  const pathValue = String(pathname || "").replace(/\/+$/, "").toLowerCase();
  return pathValue === "/v1/responses/compact" || pathValue === "/responses/compact";
}
const SUBAGENT_ROUTE_BINDING_TTL_MS = 30 * 60 * 1000;
const MAX_SUBAGENT_ROUTE_BINDINGS = 256;
type SubagentRouteBinding = {
  expiresAt: number;
  route: { model: string; reasoning_effort?: string; profile_id?: string; reason?: string; task_id?: string };
};

type GatewaySubagentWorkerCall = {
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  thought_signature?: string;
};

type GatewaySubagentTurn = {
  output: string;
  tool_calls: GatewaySubagentWorkerCall[];
  error?: string;
};

/**
 * Native Codex GPT turns stay on the native transport even when the gateway
 * is active. A child-turn boundary is the only place where the gateway may
 * inspect the request for configured subagent routing.
 */
export function isNativeCodexPassthrough(modelIsNative: boolean, _isSubagent: boolean): boolean {
  return modelIsNative;
}

function requestHeader(req: http.IncomingMessage | undefined, name: string): string {
  if (!req) return "";
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return typeof value === "string" ? value.trim() : "";
}

function requestTurnMetadata(req: http.IncomingMessage | undefined): Record<string, any> {
  const raw = requestHeader(req, "x-codex-turn-metadata");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requestKind(body: any, req: http.IncomingMessage | undefined, headerMetadata: Record<string, any>): string {
  const bodyMetadata = body?.client_metadata && typeof body.client_metadata === "object" ? body.client_metadata : {};
  return String(
    body?.request_kind ||
    bodyMetadata.request_kind ||
    headerMetadata.request_kind ||
    requestHeader(req, "x-codex-request-kind") ||
    "",
  ).trim().toLowerCase();
}

function normalizeModelProtocol(value: unknown): ModelProtocol {
  return String(value || "").trim().toLowerCase() === "responses" ? "responses" : "chat";
}

function splitConfiguredModel(value: unknown): { slug: string; backendModel: string } {
  const objectValue = value && typeof value === "object" ? value as any : undefined;
  const raw = objectValue
    ? String(objectValue.slug || objectValue.id || objectValue.model || objectValue.name || "").trim()
    : String(value || "").trim();
  const inlineBackend = objectValue
    ? String(objectValue.backend_model || objectValue.backendModel || "").trim()
    : "";
  const separator = raw.includes("=") ? "=" : (raw.includes("->") ? "->" : "");
  if (!separator) return { slug: raw, backendModel: inlineBackend || raw };
  const parts = raw.split(separator);
  return {
    slug: String(parts[0] || "").trim(),
    backendModel: String(parts.slice(1).join(separator) || parts[0] || "").trim(),
  };
}

function protocolForConfiguredModel(
  configuredModel: unknown,
  protocols: Record<string, unknown> | undefined,
  fallback: unknown = "chat",
): ModelProtocol {
  const raw = configuredModel && typeof configuredModel === "object"
    ? String((configuredModel as any).slug || (configuredModel as any).id || (configuredModel as any).model || (configuredModel as any).name || "").trim()
    : String(configuredModel || "").trim();
  const { slug, backendModel } = splitConfiguredModel(configuredModel);
  const inlineProtocol = configuredModel && typeof configuredModel === "object"
    ? (configuredModel as any).protocol || (configuredModel as any).backend_protocol
    : undefined;
  const map = protocols || {};
  return normalizeModelProtocol(map[raw] ?? map[slug] ?? map[backendModel] ?? inlineProtocol ?? fallback);
}

function buildModelProtocolMap(
  models: string[],
  protocols: Record<string, unknown> | undefined,
  fallback: unknown = "chat",
): Record<string, ModelProtocol> {
  const result: Record<string, ModelProtocol> = {};
  for (const model of models) {
    const { slug } = splitConfiguredModel(model);
    if (slug) result[slug] = protocolForConfiguredModel(model, protocols, fallback);
  }
  return result;
}


/** Decode a TOML string value — literal, basic, or bare. */
function tomlStringValue(raw: string): string {
  const text = String(raw || "").trim();
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\\\/g, "\\").replace(/\\"/g, '"');
  }
  return text;
}

/** Is this the catalog file OpenCodex generates, rather than the user's own? */
function isOpenCodexCatalogPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/.opencodex/") && normalized.endsWith("custom_model_catalog.json");
}

/** Older OpenCodex versions pointed this at their own loopback gateway. */
function isLoopbackBaseUrl(value: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(value.trim());
}

/**
 * Remove what OpenCodex added to config.toml, and nothing else.
 *
 * Marker-delimited blocks are unambiguous. The two bare keys below are not:
 * this used to strip every top-level `model_catalog_json` and
 * `openai_base_url` line outright, so a user who kept their own catalog or
 * their own proxy endpoint in config.toml silently lost it the first time
 * they pressed "restore native" or "disengage". They are still cleaned up when
 * they carry a value only OpenCodex writes — a catalog inside ~/.opencodex, or
 * a loopback base URL from a version that predated the marker blocks.
 */
export function stripManagedCodexConfig(content: string): string {
  let cleaned = content || "";
  cleaned = cleaned.replace(/# >>> opencodex managed >>>[\s\S]*?# <<< opencodex managed (?:>>>|<<<)\r?\n?/gi, "");
  cleaned = cleaned.replace(
    /^[ \t]*model_catalog_json[ \t]*=([^\n]*)$\r?\n?/gm,
    (line, value) => (isOpenCodexCatalogPath(tomlStringValue(value)) ? "" : line),
  );
  cleaned = cleaned.replace(
    /^[ \t]*openai_base_url[ \t]*=([^\n]*)$\r?\n?/gm,
    (line, value) => (isLoopbackBaseUrl(tomlStringValue(value)) ? "" : line),
  );
  cleaned = cleaned.replace(/^\s*\[model_providers\.opencodex\][\s\S]*?(?=\n\s*\[|\n\s*# >>>|$)/gm, "");
  return cleaned.trim();
}

export function buildCodexRoutingConfig(
  content: string,
  port: number,
  adminToken: string,
  catalogPath: string,
  gatewayActive: boolean,
): string {
  if (gatewayActive) return buildManagedCodexConfig(content, port, adminToken, catalogPath);
  const nativeConfig = stripManagedCodexConfig(content);
  return nativeConfig ? `${nativeConfig}\n` : "";
}

/**
 * Encode a value as a TOML string.
 *
 * A basic string treats backslash as an escape introducer, so writing a Windows
 * path directly produced `"C:\Users\..."`, where `\U` is read as a Unicode
 * escape and needs eight hex digits. That made the *whole* config.toml
 * unparseable, and Codex then failed far from the cause — including a Windows
 * sandbox setup that could never complete. Literal strings take the value
 * verbatim, which is what a path needs; the escaped basic form is only used
 * when the value itself contains an apostrophe.
 */
export function tomlString(value: string): string {
  const text = String(value ?? "");
  if (!text.includes("'") && !/[\n\r]/.test(text)) return `'${text}'`;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

export function buildManagedCodexConfig(
  content: string,
  port: number,
  adminToken: string,
  catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json")
): string {
  const preserved = stripManagedCodexConfig(content);
  // Keep the global default on native OpenAI. The provider bridge explicitly
  // assigns provider-owned models to opencodex at the thread/turn boundary;
  // making the gateway the global default hides native history whenever the
  // Desktop client is not yet attached to the bridge.
  const managedTop = `# >>> opencodex managed >>>\nmodel_catalog_json = ${tomlString(catalogPath)}\nmodel_provider = "openai"\n# <<< opencodex managed >>>\n`;
  const managedProvider = `\n# >>> opencodex managed >>>\n[model_providers.opencodex]\nname = "OpenCodex"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nexperimental_bearer_token = "${adminToken}"\nrequest_max_retries = 3\nstream_max_retries = 3\nstream_idle_timeout_ms = 600000\n# <<< opencodex managed >>>\n`;
  return `${managedTop}\n${preserved}\n${managedProvider}`;
}

type ProviderTestStatus = "untested" | "connected" | "failed" | "simulated";

/**
 * Turn a /models response status into a verdict the user can act on.
 *
 * The check previously failed only on 401 and 403 and called everything else
 * connected, which made a mistyped Base URL look like a working provider.
 */
export function describeProviderTestStatus(status: number): [ProviderTestStatus, string] {
  if (status >= 200 && status < 300) return ["connected", "服务商网络与接口连接成功"];
  if (status === 401 || status === 403) return ["failed", `接口可连通，但 API Key 无效或未授权 (HTTP ${status})`];
  if (status === 404) return ["failed", `接口返回 404：Base URL 可能多写或少写了路径（应指向 /v1 这一层）`];
  if (status === 429) return ["failed", "服务商限流 (HTTP 429)：稍后重试，或检查账户配额"];
  if (status >= 500) return ["failed", `服务商上游故障 (HTTP ${status})：不是本机配置问题，稍后重试`];
  return ["failed", `接口返回意外状态 (HTTP ${status})`];
}

function recordProviderTest(providerName: string, status: ProviderTestStatus, message: string): void {
  const name = String(providerName || "").trim().toLowerCase();
  if (!name) return;
  const providers = CredentialStore.loadProviders();
  const provider = providers.find((item: any) => item.name === name || item.preset_id === name) as any;
  if (!provider) return;
  provider.last_test_status = status;
  provider.last_test_at = new Date().toISOString();
  provider.last_test_message = message.slice(0, 500);
  // Recording the outcome is a convenience; failing to record it must not
  // turn a completed connectivity test into an error response.
  try {
    CredentialStore.saveProviders(providers);
  } catch (error: any) {
    console.warn(`[OpenCodex] Could not record the connection test result: ${error.message}`);
  }
}


function catalogModelOwner(model: any): string {
  const owner = normalizeNamespace(String(model?.backend_provider || model?.provider_name || ""));
  return owner === "opencode-go" ? "opencode" : owner;
}

function catalogModelSlug(model: any): string {
  return String(model?.slug || model?.model || model?.id || "").trim();
}

/**
 * Replace a provider's catalog entries with exactly the models it now has.
 *
 * Extracted from the /api/providers handler so the "A,B becomes B,C" case can
 * be tested at all. The removal step used to keep the wrong half: for an entry
 * this provider owned it returned `!desiredSlugs.has(...)`, deleting the
 * models still selected and preserving the ones just dropped. The upsert below
 * then re-added the selected models, so the net effect was that removed models
 * lived forever — offered in the Codex model menu and failing when chosen.
 */
export function rebuildProviderCatalogModels(
  catalog: any,
  ownerName: string,
  selectedModels: string[],
  modelProtocols: Record<string, ModelProtocol> = {},
  provider: any = "",
): void {
  if (!Array.isArray(catalog?.models)) catalog.models = [];
  catalog.models = catalog.models.filter((entry: any) => catalogModelOwner(entry) !== ownerName);

  for (const modelStr of Array.isArray(selectedModels) ? selectedModels : []) {
    const { slug, backendModel } = splitConfiguredModel(modelStr);
    if (!slug) continue;
    const capabilities = CatalogSyncService.getKnownModelMetadata(provider, backendModel)
      || CatalogSyncService.getKnownModelMetadata(provider, slug);
    upsertProviderCatalogModel(
      catalog,
      slug,
      backendModel,
      slug,
      ownerName,
      modelProtocols[slug] || "chat",
      capabilities,
    );
  }
}

export function hasThirdPartyModels(providers: ProviderConfig[] = [], catalog: any = {}): boolean {
  const providerHasModels = (Array.isArray(providers) ? providers : []).some((provider: any) =>
    [provider?.models, provider?.selected_models, provider?.active_models]
      .some((models: any) => Array.isArray(models) && models.some((model: any) => String(model || "").trim()))
  );
  if (providerHasModels) return true;
  return Array.isArray(catalog?.models) && catalog.models.some((model: any) => Boolean(catalogModelOwner(model)));
}

function normalizeNamespace(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function deriveProviderNamespace(requestedName: string, baseUrl: string): string {
  const requested = normalizeNamespace(requestedName);
  const aliases: Record<string, string> = { "opencode-go": "opencode" };
  if (requested && requested !== "custom") return aliases[requested] || requested;

  let hostname = "";
  try { hostname = new URL(baseUrl).hostname.toLowerCase(); } catch {}
  const knownHosts: Array<[string, string]> = [
    ["deepseek.com", "deepseek"],
    ["x.ai", "xai"],
    ["xiaomimimo.com", "xiaomi"],
    ["openrouter.ai", "openrouter"],
    ["minimaxi.com", "minimax"],
    ["moonshot.cn", "kimi"],
    ["aliyuncs.com", "qwen"],
    ["siliconflow.cn", "siliconflow"],
    ["opencode.ai", "opencode"],
    ["volces.com", "volcengine"],
    ["anthropic.com", "claude"],
    ["openai.com", "openai"],
  ];
  const known = knownHosts.find(([suffix]) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  if (known) return known[1];

  const labels = hostname.split(".").filter(Boolean).filter((label) => !["api", "www", "llm", "gateway", "chat"].includes(label));
  if (labels.length > 1) labels.pop();
  const derived = normalizeNamespace(labels.join("-"));
  return derived || "custom";
}

function providerUrlFingerprint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(baseUrl || "").trim().toLowerCase();
  }
}

function stableShortHash(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

function namespaceModelSlug(providerName: string, rawSlug: string): string {
  const owner = normalizeNamespace(providerName) || "provider";
  const slug = String(rawSlug || "").trim();
  if (!slug) return `${owner}/model`;
  return slug.toLowerCase().startsWith(`${owner}/`) ? slug : `${owner}/${slug}`;
}

function providerDisplayName(providerName: string, rawSlug: string): string {
  const owner = normalizeNamespace(providerName) || "provider";
  const slug = String(rawSlug || "").trim();
  const unscoped = slug.toLowerCase().startsWith(`${owner}/`)
    ? slug.slice(owner.length + 1)
    : slug;
  return `${owner}/${unscoped || "model"}`;
}

export function buildConfiguredProviderCatalogEntries(providers: ProviderConfig[]): any[] {
  const entries: any[] = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    const owner = normalizeNamespace(String(provider?.name || provider?.preset_id || ""));
    if (!owner || !Array.isArray(provider?.models)) continue;
    for (const configuredModel of provider.models) {
      const { slug: rawSlug, backendModel } = splitConfiguredModel(configuredModel);
      if (!rawSlug || !backendModel) continue;
      const slug = namespaceModelSlug(owner, rawSlug);
      const protocol = protocolForConfiguredModel(configuredModel, provider.model_protocols);
      const capabilities = CatalogSyncService.getKnownModelMetadata(provider, backendModel)
        || CatalogSyncService.getKnownModelMetadata(provider, rawSlug);
      const entry = buildFullCatalogEntry(
        slug,
        owner,
        undefined,
        protocol,
        capabilities,
      );
      entries.push({
        ...entry,
        slug,
        model: slug,
        display_name: providerDisplayName(owner, slug),
        backend_provider: owner,
        backend_model: backendModel,
        protocol,
        backend_protocol: protocol,
      });
    }
  }
  return entries;
}

function runtimeProviderCatalogEntries(): any[] {
  return buildConfiguredProviderCatalogEntries(CredentialStore.loadProviders());
}

function isOfficialCachedModel(model: any): boolean {
  const slug = catalogModelSlug(model).toLowerCase();
  if (!slug || slug === "codex-auto-review" || catalogModelOwner(model)) return false;
  const provider = String(model?.provider || model?.model_provider || "").trim().toLowerCase();
  return provider === "openai" || /^(gpt-|o\d|codex-|chatgpt)/i.test(slug);
}

function readOfficialModelMap(): Map<string, any> {
  const official = new Map<string, any>();
  const cachePath = path.join(codexHomePath(), "models_cache.json");
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    for (const model of Array.isArray(cache.models) ? cache.models : []) {
      if (isOfficialCachedModel(model)) official.set(catalogModelSlug(model).toLowerCase(), model);
    }
  } catch {}

  // The cache is normally authoritative. If it is absent or empty, ask the
  // native Codex installation for its current catalog instead of inventing a
  // list. This keeps official models independent from imported providers.
  if (official.size === 0) {
    for (const model of CatalogSyncService.getOfficialModels()) {
      const slug = catalogModelSlug(model).toLowerCase();
      if (slug && slug !== "codex-auto-review") official.set(slug, model);
    }
  }
  return official;
}

function scopedCatalogSlug(providerName: string, rawSlug: string, usedSlugs: Set<string>): string {
  const base = `${providerName}/${rawSlug}`;
  let candidate = base;
  let suffix = 2;
  while (usedSlugs.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

export function migrateProviderCatalogOwner(catalog: any, previousProviderName: string, nextProviderName: string): void {
  if (!catalog || !Array.isArray(catalog.models)) return;
  const previous = normalizeNamespace(previousProviderName);
  const next = normalizeNamespace(nextProviderName);
  if (!previous || !next || previous === next) return;

  const migrated: any[] = [];
  for (const model of catalog.models) {
    if (catalogModelOwner(model) !== previous) {
      migrated.push(model);
      continue;
    }

    const currentSlug = catalogModelSlug(model);
    const rawSlug = currentSlug.toLowerCase().startsWith(`${previous}/`)
      ? currentSlug.slice(previous.length + 1)
      : String(model?.backend_model || currentSlug).trim();
    if (!rawSlug) continue;

    const backendModel = String(model?.backend_model || rawSlug).trim();
    const duplicate = migrated.find((entry: any) =>
      catalogModelOwner(entry) === next
      && String(entry?.backend_model || "").trim().toLowerCase() === backendModel.toLowerCase()
    );
    if (duplicate) continue;

    const usedSlugs = new Set<string>(migrated
      .map((entry: any) => catalogModelSlug(entry).toLowerCase())
      .filter(Boolean));
    const canonical = namespaceModelSlug(next, rawSlug);
    const slug = usedSlugs.has(canonical.toLowerCase())
      ? scopedCatalogSlug(next, rawSlug, usedSlugs)
      : canonical;
    migrated.push({
      ...model,
      slug,
      model: slug,
      backend_provider: next,
      backend_model: backendModel,
      display_name: providerDisplayName(next, slug)
    });
  }

  catalog.models = migrated;
}

export function upsertProviderCatalogModel(
  catalog: any,
  rawSlug: string,
  backendModel: string,
  displayName: string,
  providerName: string,
  protocol: ModelProtocol = "chat",
  capabilities?: any,
): void {
  if (!catalog || typeof catalog !== "object") return;
  if (!Array.isArray(catalog.models)) catalog.models = [];

  const slug = String(rawSlug || "").trim();
  const backend = String(backendModel || slug).trim();
  const owner = normalizeNamespace(providerName);
  const normalizedProtocol = normalizeModelProtocol(protocol);
  if (!slug || !backend || !owner) return;
  const canonicalSlug = namespaceModelSlug(owner, slug);

  const owned = catalog.models.find((model: any) => {
    if (catalogModelOwner(model) !== owner) return false;
    const modelSlug = catalogModelSlug(model).toLowerCase();
    const modelBackend = String(model?.backend_model || "").trim().toLowerCase();
    return modelSlug === canonicalSlug.toLowerCase()
      || modelSlug === slug.toLowerCase()
      || modelBackend === slug.toLowerCase()
      || modelBackend === backend.toLowerCase();
  });
  if (owned) {
    const existingCapabilities = capabilities || owned;
    const refreshed = buildFullCatalogEntry(
      canonicalSlug,
      owner,
      undefined,
      normalizedProtocol,
      existingCapabilities,
    );
    Object.assign(owned, refreshed, {
      slug: canonicalSlug,
      model: canonicalSlug,
      backend_model: backend,
      display_name: providerDisplayName(owner, canonicalSlug),
    });
    return;
  }

  const usedSlugs = new Set<string>(catalog.models
    .map((model: any) => catalogModelSlug(model).toLowerCase())
    .filter((slug: string) => Boolean(slug)));
  const catalogSlug = usedSlugs.has(canonicalSlug.toLowerCase())
    ? scopedCatalogSlug(owner, slug, usedSlugs)
    : canonicalSlug;
  const entry = buildFullCatalogEntry(catalogSlug, owner, undefined, normalizedProtocol, capabilities);
  entry.backend_model = backend;
  entry.display_name = providerDisplayName(owner, catalogSlug);
  catalog.models.push(entry);
}

export function preserveOfficialModels(catalog: any): void {
  if (!catalog || typeof catalog !== "object") return;
  if (!Array.isArray(catalog.models)) catalog.models = [];

  const officialMap = readOfficialModelMap();
  const usedSlugs = new Set<string>(officialMap.keys());
  const ownerless: any[] = [];
  const thirdParty: any[] = [];

  for (const model of catalog.models) {
    const slug = catalogModelSlug(model);
    if (!slug) continue;
    const key = slug.toLowerCase();
    const owner = catalogModelOwner(model);

    if (!owner) {
      if (officialMap.has(key)) continue;
      if (!usedSlugs.has(key)) {
        usedSlugs.add(key);
        ownerless.push(model);
      }
      continue;
    }

    // Every provider-owned model gets a stable namespace, even when there is
    // no current collision. This makes future imports and provider changes
    // order-independent.
    const rawSlug = slug.toLowerCase().startsWith(`${owner}/`)
      ? slug.slice(owner.length + 1)
      : slug;
    const canonical = namespaceModelSlug(owner, rawSlug);
    const alias = usedSlugs.has(canonical.toLowerCase())
      ? scopedCatalogSlug(owner, rawSlug, usedSlugs)
      : canonical;
    const backendModel = String(model.backend_model || rawSlug).trim();
    const configuredProvider = CredentialStore.loadProviders().find((provider: any) =>
      normalizeNamespace(String(provider?.name || provider?.preset_id || "")) === owner
    );
    const backendMetadata = configuredProvider
      ? CatalogSyncService.getKnownModelMetadata(configuredProvider, backendModel)
      : undefined;
    const existingReasoningLevels = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
      : [];
    const legacyDefaultReasoning = JSON.stringify(existingReasoningLevels.map((level: any) => String(level?.effort || "").toLowerCase()))
      === JSON.stringify(getDefaultReasoningPresets().map((level) => level.effort));
    const discoveredReasoningLevels = backendMetadata
      ? backendMetadata.supported_reasoning_levels
      : undefined;
    const capabilities = {
      // Registry metadata may fill descriptive capabilities, but it must not
      // replace a context window previously verified by the active provider.
      ...model,
      ...(backendMetadata || {}),
      ...(existingReasoningLevels.length > 0
        && !legacyDefaultReasoning
        ? { supported_reasoning_levels: existingReasoningLevels }
        : {}),
    };
    if (model.context_window_source === "provider_metadata"
      && backendMetadata?.context_window_source !== "provider_metadata") {
      capabilities.context_window = model.context_window;
      capabilities.max_context_window = model.max_context_window || model.context_window;
      capabilities.context_window_source = "provider_metadata";
      if (capabilities.metadata_source === "model_registry") capabilities.metadata_source = "provider_metadata";
    }
    const refreshed = buildFullCatalogEntry(
      alias,
      owner,
      undefined,
      normalizeModelProtocol(model.protocol || model.backend_protocol),
      capabilities,
    );
    const moved = applyDefaultReasoningCapabilities({
      ...model,
      ...refreshed,
      slug: alias,
      model: alias,
      backend_provider: owner,
      backend_model: backendModel,
      display_name: providerDisplayName(owner, alias)
    });
    usedSlugs.add(alias.toLowerCase());
    thirdParty.push(moved);
  }

  // The provider configuration is the durable source of the user's selected
  // model list. If an older cache/catalog was partially written, reconstruct
  // missing provider-owned entries from it before publishing the catalog.
  // Deleting a model also removes it from provider.models, so this does not
  // resurrect an intentionally deleted entry.
  for (const configured of runtimeProviderCatalogEntries()) {
    const owner = catalogModelOwner(configured);
    const backendModel = String(configured?.backend_model || "").trim().toLowerCase();
    if (!owner || !backendModel) continue;
    const existing = thirdParty.find((entry: any) =>
      catalogModelOwner(entry) === owner
      && String(entry?.backend_model || "").trim().toLowerCase() === backendModel
    );
    if (existing) continue;

    const rawSlug = String(configured.slug || configured.model || backendModel).trim();
    const canonical = namespaceModelSlug(owner, rawSlug);
    const alias = usedSlugs.has(canonical.toLowerCase())
      ? scopedCatalogSlug(owner, rawSlug, usedSlugs)
      : canonical;
    const restored = {
      ...configured,
      slug: alias,
      model: alias,
      backend_provider: owner,
      backend_model: backendModel,
      display_name: providerDisplayName(owner, alias),
    };
    usedSlugs.add(alias.toLowerCase());
    thirdParty.push(restored);
  }

  // Official native entries are deliberately first; the web endpoint filters
  // them out, while the desktop client receives them before third-party ones.
  catalog.models = [...officialMap.values(), ...ownerless, ...thirdParty];
}


function credentialsMatch(candidate: string, expected: string): boolean {
  if (!candidate || !expected) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function resolveRuntimeBinary(name: string): string {
  const runtimeDir = process.env.OPENCODEX_VOICE_RUNTIME_DIR;
  const candidates = [
    runtimeDir ? path.join(runtimeDir, name) : "",
    path.join(os.homedir(), ".local", "bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    name
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === name || fs.existsSync(candidate)) || name;
}

function listRolloutFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(entryPath);
    }
  };
  visit(root);
  return result;
}

function readLogTail(filePath: string, maxBytes = 256 * 1024): string[] {
  if (!fs.existsSync(filePath)) return [];
  let fd: number | null = null;
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf-8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function redactLogLine(line: string): string {
  return line
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9_-]{12,})/g, "[REDACTED]");
}

function isGatewayReasoningItem(record: any): boolean {
  const payload = record?.type === "response_item" ? record.payload : record;
  if (!payload || payload.type !== "reasoning") return false;

  const id = typeof payload.id === "string" ? payload.id : "";
  const legacyGatewayId = /^rs_\d{13}_\d+$/i.test(id);
  const v2GatewayId = /^rs_[0-9a-f]{16}$/i.test(id) && payload.encrypted_content == null;
  const importedThinking = typeof payload.encrypted_content === "string"
    && payload.encrypted_content.startsWith("anthropic-thinking-v1:");
  return legacyGatewayId || v2GatewayId || importedThinking;
}

function isForeignResponsesReasoningItem(record: any): boolean {
  const payload = record?.type === "response_item" ? record.payload : record;
  if (!payload || payload.type !== "reasoning") return false;
  const id = typeof payload.id === "string" ? payload.id : "";
  return Boolean(id) && !isNativeResponsesReasoningId(id);
}

function normalizeStoredFunctionCallId(record: any): boolean {
  const payload = record?.type === "response_item" ? record.payload : record;
  if (!payload || payload.type !== "function_call" || typeof payload.id !== "string") return false;
  if (/^fc_[A-Za-z0-9_-]+$/.test(payload.id)) return false;

  const safeSource = payload.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "legacy";
  payload.id = `fc_import_${safeSource}`;
  return true;
}

export interface RolloutRepairSummary {
  /** Rollout files examined. */
  inspected: number;
  /** Files carrying proof this gateway wrote into them. */
  owned: number;
  /** Owned files that needed a change (and got one, unless dryRun). */
  repaired: number;
  /** Files left untouched: no provenance, or unreadable. */
  skipped: number;
  /** Owned files that needed a change but could not be written. */
  failed: number;
}

/**
 * Did this gateway write into this rollout?
 *
 * The only honest evidence is a record carrying an id this gateway itself
 * mints. Everything else — a reasoning id that merely looks unfamiliar, a
 * function_call id in an unexpected shape — is just as likely to be a Codex
 * version we have not seen, or another tool's session.
 *
 * Without this gate the repair walked every file under ~/.codex and rewrote
 * anything it did not recognize, including sessions that never went near
 * OpenCodex.
 */
function rolloutHasGatewayProvenance(records: any[]): boolean {
  return records.some(isGatewayReasoningItem);
}

/**
 * Replace a rollout without risking the original.
 *
 * The previous version wrote straight over the file, so a crash, a full disk
 * or an antivirus interception left a truncated session. Session history
 * cannot be regenerated, so keep a copy and swap by rename.
 */
function writeRolloutAtomically(rolloutPath: string, contents: string): void {
  const directory = path.dirname(rolloutPath);
  const temporaryPath = path.join(directory, `.${path.basename(rolloutPath)}.${process.pid}.tmp`);
  fs.copyFileSync(rolloutPath, `${rolloutPath}.opencodex-backup`);
  try {
    fs.writeFileSync(temporaryPath, contents, "utf-8");
    fs.renameSync(temporaryPath, rolloutPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

/**
 * Remove gateway-created reasoning records before native mode resumes.
 *
 * Native Responses reasoning records carry server-managed encrypted content;
 * deleting those would damage a normal GPT rollout, so the V2 pattern also
 * requires the null encrypted_content that this gateway emitted. Within a
 * rollout we can prove is ours, records the native backend would reject are
 * removed too — that is the point of the repair. Outside such a rollout,
 * nothing is touched at all.
 */
export function repairNativeRollouts(options: { dryRun?: boolean } = {}): RolloutRepairSummary {
  const roots = [
    path.join(codexHomePath(), "sessions"),
    path.join(codexHomePath(), "archived_sessions"),
  ];
  const summary: RolloutRepairSummary = { inspected: 0, owned: 0, repaired: 0, skipped: 0, failed: 0 };

  for (const rolloutPath of roots.flatMap(listRolloutFiles)) {
    summary.inspected++;

    let records: any[];
    try {
      records = fs.readFileSync(rolloutPath, "utf-8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      // An unparseable rollout is somebody else's format, or already damaged.
      // Either way, rewriting it can only make things worse.
      summary.skipped++;
      continue;
    }

    if (!rolloutHasGatewayProvenance(records)) {
      summary.skipped++;
      continue;
    }
    summary.owned++;

    let changed = false;
    for (const record of records) {
      if (normalizeStoredFunctionCallId(record)) changed = true;
    }

    const sanitized = records.filter((record) => {
      if (isGatewayReasoningItem(record) || isForeignResponsesReasoningItem(record)) {
        changed = true;
        return false;
      }
      return true;
    });
    if (!changed) continue;

    if (options.dryRun) {
      summary.repaired++;
      continue;
    }

    try {
      writeRolloutAtomically(rolloutPath, `${sanitized.map((record) => JSON.stringify(record)).join("\n")}\n`);
      summary.repaired++;
    } catch (error: any) {
      summary.failed++;
      console.error(`[OpenCodex V2] Could not repair native rollout ${rolloutPath}: ${error.message}`);
    }
  }

  console.log(
    `[OpenCodex V2] Rollout repair${options.dryRun ? " (dry run)" : ""}: `
    + `${summary.inspected} inspected, ${summary.owned} ours, ${summary.repaired} repaired, `
    + `${summary.skipped} left untouched, ${summary.failed} failed.`,
  );
  return summary;
}

export class CodexBridgeServer {
  private port: number;
  private server: http.Server | null = null;
  private serverLockFd: number | null = null;
  private serverLockPath = "";
  // Only the instance that actually published the bridge environment may clear
  // it again. A second gateway that loses the port race must not detach the
  // Desktop client belonging to the instance that won.
  private registeredProviderBridge = false;
  private gatewayRestartInProgress = false;
  private router = new GatewayRouter();
  private claudeModelFetchError = "";
  public config: any = { providers: [] };
  private readonly dataDir: string;
  private readonly desktopRestartMarkerPath: string;
  private readonly adminToken: string;
  private readonly taskRouter: TaskRouter;
  private readonly subagentOrchestrator: SubagentOrchestrator;
  private subagentRouteBindings = new Map<string, SubagentRouteBinding>();
  /**
   * Every escape from this process into the host — the registry, taskkill,
   * launching Desktop — goes through here. Injected so tests can drive the
   * gateway without publishing CODEX_CLI_PATH into the developer's own
   * environment and deleting it again on stop.
   */
  private readonly desktop: DesktopController;
  private desktopLaunchTimer: NodeJS.Timeout | null = null;

  constructor(port = 8765, desktop: DesktopController = desktopController) {
    this.port = port;
    this.desktop = desktop;
    this.dataDir = process.env.OPENCODEX_DATA_DIR || path.join(os.homedir(), ".opencodex");
    this.desktopRestartMarkerPath = path.join(this.dataDir, "restart_desktop_after_gateway_ready");
    this.adminToken = this.loadOrCreateAdminToken();
    this.taskRouter = new TaskRouter(this.dataDir);
    this.subagentOrchestrator = new SubagentOrchestrator(this.dataDir);
    this.router.setSubagentDispatcher((calls, context) => this.dispatchThirdPartySubagents(calls, context));
    this.config.providers = CredentialStore.loadProviders();
  }

  private resolveSubagentWorkspacePath(rawValue: unknown): string {
    const root = path.resolve(process.cwd());
    let raw = String(rawValue || ".").trim() || ".";
    if (raw === "~") raw = ".";
    if (raw.startsWith("~/")) raw = raw.slice(2);
    const requested = path.resolve(root, raw);
    if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) {
      throw new Error("子代理工具只能访问当前工作区");
    }
    return requested;
  }

  private async executeGatewaySubagentWorkerTool(call: GatewaySubagentWorkerCall): Promise<string> {
    let args: any = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return JSON.stringify({ error: "工具参数不是有效 JSON" });
    }

    const name = String(call.name || "").trim().toLowerCase();
    try {
      if (name === "view_file") {
        const filePath = this.resolveSubagentWorkspacePath(args?.path);
        const content = fs.readFileSync(filePath, "utf8");
        return JSON.stringify({ path: filePath, content: content.slice(0, 200_000) });
      }
      if (name === "list_dir") {
        const directory = this.resolveSubagentWorkspacePath(args?.path);
        const entries = fs.readdirSync(directory, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        }));
        return JSON.stringify({ path: directory, entries });
      }
      // exec_command is deliberately not implemented here.
      //
      // It used to run `execFileAsync("/bin/zsh", ["-lc", command])`
      // unconditionally, which on Windows — the only platform this fork
      // targets — meant every third-party subagent that reached for a shell
      // failed on a missing path. Making it work per-platform was the obvious
      // repair and the wrong one: resolveSubagentWorkspacePath only constrains
      // the working directory, so `-lc` still ran an arbitrary login-shell
      // command with full access to absolute paths, the network and system
      // tools, outside Codex's approval and sandbox chain entirely.
      //
      // The main agent already has that chain. Handing the command back to it
      // keeps one audited path for execution instead of a second unaudited
      // one, and the model can act on this answer.
      if (name === "exec_command") {
        return JSON.stringify({
          error: "子代理无法直接执行命令。请把需要执行的命令连同理由返回给主 Agent，由它通过 Codex 的审批与沙箱机制运行。",
        });
      }
      return JSON.stringify({ error: `网关未实现子代理工具：${name || "(unnamed)"}` });
    } catch (error: any) {
      return JSON.stringify({ error: String(error?.message || error || "子代理工具执行失败") });
    }
  }

  /**
   * Write one provider-bound request to disk when OPENCODEX_DEBUG_REQUEST_DUMP
   * names a directory. Diagnostic only: it is off unless the variable is set,
   * and it records the request as the gateway is about to forward it, which is
   * the only place the full `input` can be compared against what the parent
   * agent believes it sent.
   */
  private dumpRequestForDebug(body: any, req?: http.IncomingMessage): void {
    const directory = String(process.env.OPENCODEX_DEBUG_REQUEST_DUMP || "").trim();
    if (!directory) return;
    try {
      fs.mkdirSync(directory, { recursive: true });
      const headers: Record<string, string> = {};
      for (const name of ["x-openai-subagent", "x-codex-turn-metadata", "x-codex-parent-thread-id", "x-codex-request-kind"]) {
        const value = requestHeader(req, name);
        if (value) headers[name] = value;
      }
      const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
      fs.writeFileSync(
        path.join(directory, `request-${stamp}.json`),
        JSON.stringify({ model: body?.model, headers, body }, null, 2),
        { encoding: "utf-8", mode: 0o600 },
      );
    } catch (error: any) {
      console.warn(`[OpenCodex Debug] Could not write request dump: ${error?.message || error}`);
    }
  }

  private async dispatchThirdPartySubagents(
    calls: GatewaySubagentDispatchCall[],
    context: GatewaySubagentDispatchContext,
  ): Promise<GatewaySubagentDispatchResult[]> {
    return Promise.all(calls.map((call, index) => this.dispatchThirdPartySubagent(call, context, index)));
  }

  private async dispatchThirdPartySubagent(
    call: GatewaySubagentDispatchCall,
    context: GatewaySubagentDispatchContext,
    index: number,
  ): Promise<GatewaySubagentDispatchResult> {
    let argumentsValue: any = {};
    try {
      argumentsValue = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return { call_id: call.call_id, output: "", error: "spawn_agent 参数不是有效 JSON" };
    }

    const message = String(argumentsValue?.message || argumentsValue?.task || argumentsValue?.instructions || "").trim();
    const forcedModel = String(argumentsValue?.model || "").trim();
    const profileId = String(argumentsValue?.profile_id || "").trim();
    const callReasoning = String(
      argumentsValue?.reasoning_effort || argumentsValue?.reasoning?.effort || "",
    ).trim();
    const taskName = String(argumentsValue?.task_name || "").trim();
    if (!message) {
      return { call_id: call.call_id, output: "", error: "spawn_agent 缺少 message" };
    }

    const taskId = `gateway-child-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 7)}`;
    // This function is the spawn_agent boundary. It must forward the
    // unresolved child request to the gateway and let chooseSubagentRoute()
    // make the only routing decision. In particular, do not call TaskRouter
    // or start a task here: doing so creates two route records and can bind a
    // child to a model before the request reaches /v1/responses.
    const childBody: any = {
      input: message,
      stream: true,
      client_metadata: {
        "x-openai-subagent": "1",
        thread_source: "subagent",
        subagent_kind: "gateway-spawn-agent",
        request_kind: "turn",
        session_id: taskId,
        parent_task_id: context.parent_task_id || "gateway-main",
        turn_id: `turn-${taskId}`,
        ...(forcedModel ? { model_override: forcedModel } : {}),
        ...(profileId ? { profile_id: profileId } : {}),
        ...(taskName ? { task_type: taskName } : {}),
        ...(callReasoning ? { reasoning_effort: callReasoning } : {}),
      },
    };

    try {
      let childInput: any = message;
      const childHistory: any[] = [];
      for (let toolRound = 0; toolRound <= 32; toolRound += 1) {
        const childResponse = await fetch(`http://127.0.0.1:${this.port}/v1/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.adminToken}`,
            "x-openai-subagent": "1",
            "x-codex-parent-thread-id": context.parent_task_id || "gateway-main",
          },
          body: JSON.stringify({ ...childBody, input: childInput }),
          signal: AbortSignal.timeout(600_000),
        });
        if (!childResponse.ok) {
          const errorText = await childResponse.text();
          throw new Error(`子代理 HTTP ${childResponse.status}: ${errorText.slice(0, 800)}`);
        }
        const turn = await this.readGatewaySubagentOutput(childResponse);
        if (turn.error) throw new Error(turn.error);
        if (turn.tool_calls.length === 0) {
          if (!turn.output) throw new Error("子代理没有返回文本结果");
          const selectedModel = childResponse.headers.get("x-opencodex-subagent-model") || undefined;
          const selectedReasoning = childResponse.headers.get("x-opencodex-subagent-reasoning-effort") || undefined;
          const selectedTaskId = childResponse.headers.get("x-opencodex-subagent-task-id") || taskId;
          return {
            call_id: call.call_id,
            task_id: selectedTaskId,
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(selectedReasoning ? { reasoning_effort: selectedReasoning } : {}),
            output: turn.output,
          };
        }

        if (turn.output) {
          childHistory.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: turn.output }],
          });
        }
        childHistory.push(...turn.tool_calls.map((workerCall) => ({
          type: "function_call",
          id: workerCall.id,
          call_id: workerCall.call_id,
          name: workerCall.name,
          arguments: workerCall.arguments,
          ...(workerCall.thought_signature
            ? { thought_signature: workerCall.thought_signature, thoughtSignature: workerCall.thought_signature }
            : {}),
        })));
        const toolResults = await Promise.all(turn.tool_calls.map((workerCall) =>
          this.executeGatewaySubagentWorkerTool(workerCall)
        ));
        childHistory.push(...turn.tool_calls.map((workerCall, resultIndex) => ({
          type: "function_call_output",
          call_id: workerCall.call_id,
          output: toolResults[resultIndex],
        })));
        childInput = [
          { type: "message", role: "user", content: [{ type: "input_text", text: message }] },
          ...childHistory,
        ];
      }
      throw new Error("子代理工具调用超过 32 轮，已停止继续执行");
    } catch (error: any) {
      const messageText = String(error?.message || error || "子代理执行失败").slice(0, 1000);
      this.subagentOrchestrator.fail(taskId, messageText);
      return {
        call_id: call.call_id,
        task_id: taskId,
        output: "",
        error: messageText,
      };
    }
  }

  private async readGatewaySubagentOutput(response: Response): Promise<GatewaySubagentTurn> {
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let fallbackText = "";
    let failure = "";
    const toolCalls = new Map<string, GatewaySubagentWorkerCall>();

    const consume = (raw: string): void => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      const dataLines = trimmed.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
      const data = dataLines.length > 0 ? dataLines.join("\n") : trimmed;
      if (!data || data === "[DONE]") return;
      let payload: any;
      try { payload = JSON.parse(data); } catch { return; }
      const type = String(payload?.type || "");
      if (type === "response.output_text.delta") text += String(payload.delta || "");
      if (type === "response.output_item.done" && payload.item?.type === "message") {
        const content = Array.isArray(payload.item.content)
          ? payload.item.content.map((part: any) => part?.text || "").join("")
          : "";
        if (content) fallbackText += content;
      }
      const rememberToolCall = (item: any): void => {
        if (!item || item.type !== "function_call") return;
        const id = String(item.id || item.call_id || `worker-call-${toolCalls.size}`).trim();
        const callId = String(item.call_id || item.id || id).trim();
        const existing = toolCalls.get(callId) || toolCalls.get(id);
        const next: GatewaySubagentWorkerCall = {
          id: String(existing?.id || id),
          call_id: callId,
          name: String(item.name || existing?.name || "").trim(),
          arguments: typeof item.arguments === "string" ? item.arguments : existing?.arguments || JSON.stringify(item.arguments || {}),
          ...((item.thought_signature || item.thoughtSignature || existing?.thought_signature)
            ? { thought_signature: String(item.thought_signature || item.thoughtSignature || existing?.thought_signature) }
            : {}),
        };
        toolCalls.delete(id);
        toolCalls.delete(callId);
        toolCalls.set(callId, next);
      };
      if (type === "response.output_item.added" || type === "response.output_item.done") {
        rememberToolCall(payload.item);
      }
      if (type === "response.function_call_arguments.delta") {
        const itemId = String(payload.item_id || payload.call_id || "").trim();
        const existing = Array.from(toolCalls.values()).find((call) => call.id === itemId || call.call_id === itemId);
        if (existing) existing.arguments += String(payload.delta || "");
      }
      if (type === "response.function_call_arguments.done") {
        const itemId = String(payload.item_id || payload.call_id || "").trim();
        const existing = Array.from(toolCalls.values()).find((call) => call.id === itemId || call.call_id === itemId);
        if (existing && typeof payload.arguments === "string") existing.arguments = payload.arguments;
      }
      if (type === "response.failed") {
        failure = String(payload.response?.error?.message || payload.response?.error || "子代理返回失败");
      }
      if (type === "response.completed" && payload.response?.status === "failed") {
        failure = String(payload.response?.error?.message || payload.response?.error || "子代理返回失败");
      }
      if (type === "response.completed" && Array.isArray(payload.response?.output)) {
        for (const item of payload.response.output) rememberToolCall(item);
      }
    };

    if (!response.body) throw new Error("子代理没有返回响应流");
    // @ts-ignore Node's fetch body is an async iterable at runtime.
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      for (const event of events) consume(event);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    const result = (text || fallbackText).trim();
    return {
      output: result,
      tool_calls: Array.from(toolCalls.values()).filter((call) => Boolean(call.name)),
      ...(failure ? { error: failure } : {}),
    };
  }

  private loadOrCreateAdminToken(): string {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tokenPath = path.join(this.dataDir, "admin_token");
    try {
      const existing = fs.readFileSync(tokenPath, "utf-8").trim();
      if (existing.length >= 32) {
        fs.chmodSync(tokenPath, 0o600);
        return existing;
      }
    } catch {}

    const token = randomBytes(32).toString("hex");
    fs.writeFileSync(tokenPath, `${token}\n`, { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600);
    return token;
  }

  private requestDesktopLaunchAfterGatewayReady(): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.desktopRestartMarkerPath, `${Date.now()}\n`, { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(this.desktopRestartMarkerPath, 0o600); } catch {}
  }

  private launchDesktopAfterGatewayReadyIfRequested(): void {
    if (!fs.existsSync(this.desktopRestartMarkerPath)) return;
    try {
      fs.unlinkSync(this.desktopRestartMarkerPath);
    } catch (error: any) {
      console.warn(`[OpenCodex Gateway] Could not consume desktop restart marker: ${error?.message || error}`);
      return;
    }

    // Held so stop() can cancel it. An armed timer that outlived the server
    // could still restart Desktop long after the gateway that scheduled it
    // was gone — in the test suite, mid-run.
    this.desktopLaunchTimer = setTimeout(() => {
      this.desktopLaunchTimer = null;
      if (this.desktop.desktopAppServerState() === "bridge") {
        console.log("[OpenCodex Gateway] Desktop is already attached to the provider bridge; skipped Desktop restart.");
        return;
      }
      // A native app-server cannot receive CODEX_CLI_PATH retroactively. Only
      // this one-time takeover path restarts Desktop; ordinary gateway
      // start/stop cycles leave an already-bridged Desktop untouched.
      this.restartDesktop(true);
      console.log("[OpenCodex Gateway] Gateway is ready; launched Desktop through the provider bridge after model catalog initialization.");
    }, 500);
    this.desktopLaunchTimer.unref?.();
  }

  /** Stop and relaunch Desktop through the injected controller. */
  private restartDesktop(launchWithCdp: boolean): void {
    this.desktop.stopDesktopClients();
    this.desktop.launchDesktopClient(launchWithCdp);
  }

  private isSubagentResponsesRequest(body: any, req?: http.IncomingMessage): boolean {
    const metadata = body?.client_metadata && typeof body.client_metadata === "object" ? body.client_metadata : {};
    const headerMetadata = requestTurnMetadata(req);
    const subagentHeader = requestHeader(req, "x-openai-subagent");
    const headerMarksSubagent = Boolean(
      subagentHeader ||
      headerMetadata.thread_source === "subagent" ||
      headerMetadata.subagent_kind ||
      requestHeader(req, "x-codex-parent-thread-id"),
    );
    // Codex sends a prewarm request for a native child before the real turn.
    // It carries the same subagent headers but must not create or route a task.
    if (requestKind(body, req, headerMetadata) === "prewarm") return false;
    return Boolean(
      metadata["x-openai-subagent"] === true ||
      metadata["x-openai-subagent"] === "1" ||
      metadata.thread_source === "subagent" ||
      body?.thread_source === "subagent" ||
      body?.source?.subagent === true ||
      headerMarksSubagent,
    );
  }

  private chooseSubagentRoute(body: any, req?: http.IncomingMessage): { model: string; reasoning_effort?: string; profile_id?: string; reason?: string; task_id?: string } | null {
    if (!this.isSubagentResponsesRequest(body, req)) return null;
    const bodyMetadata = body?.client_metadata && typeof body.client_metadata === "object" ? body.client_metadata : {};
    const headerMetadata = requestTurnMetadata(req);
    const metadata = { ...headerMetadata, ...bodyMetadata };
    // Codex child turns can carry the parent session in `session_id` while
    // `thread_id` identifies the actual child. Route/task bindings must use
    // the child identity first; otherwise concurrent children of one parent
    // overwrite each other's model and lifecycle state.
    const taskId = String(
      metadata.child_thread_id ||
      metadata.subagent_thread_id ||
      metadata.thread_id ||
      body?.child_thread_id ||
      body?.subagent_thread_id ||
      body?.thread_id ||
      requestHeader(req, "thread-id") ||
      requestHeader(req, "x-client-request-id") ||
      metadata.session_id ||
      metadata.conversation_id ||
      body?.session_id ||
      body?.conversation_id ||
      requestHeader(req, "session-id") ||
      "__active__",
    ).trim() || "__active__";
    const bodyModel = this.stripReasoningSuffix(String(body?.model || "").trim());
    const bodyModelIsNative = Boolean(bodyModel) && this.isNativeCatalogModel(bodyModel);
    const explicitModel = String(
      body?.forced_model ||
      body?.subagent_model ||
      body?.child_model ||
      body?.agent_model ||
      metadata.forced_model ||
      metadata.forcedModel ||
      metadata.subagent_model ||
      metadata.child_model ||
      metadata.agent_model ||
      metadata.model_override ||
      // For a child request, a non-native body model is itself an explicit
      // target. Native GPT is the inherited parent model and must not be
      // mistaken for a user-selected third-party child model.
      (!bodyModelIsNative ? bodyModel : "") ||
      "",
    ).trim();
    const now = Date.now();
    for (const [bindingId, binding] of this.subagentRouteBindings) {
      if (binding.expiresAt <= now) this.subagentRouteBindings.delete(bindingId);
    }
    const existingBinding = taskId !== "__active__" ? this.subagentRouteBindings.get(taskId) : undefined;
    const explicitReasoning = String(
      body?.reasoning?.effort ||
      body?.reasoning_effort ||
      metadata.reasoning_effort ||
      "",
    ).trim();
    if (existingBinding && (!explicitModel || explicitModel.toLowerCase() === existingBinding.route.model.toLowerCase())) {
      existingBinding.expiresAt = now + SUBAGENT_ROUTE_BINDING_TTL_MS;
      const reasoning = explicitReasoning
        ? this.taskRouter.normalizeReasoningEffort(existingBinding.route.model, explicitReasoning, true) || existingBinding.route.reasoning_effort
        : existingBinding.route.reasoning_effort;
      existingBinding.route = {
        ...existingBinding.route,
        ...(reasoning ? { reasoning_effort: reasoning } : {}),
      };
      console.log(`[OpenCodex Subagent] Reusing child route: ${existingBinding.route.model}${existingBinding.route.reasoning_effort ? ` reasoning=${existingBinding.route.reasoning_effort}` : ""}`);
      return existingBinding.route;
    }
    // The child model is whatever the parent named. There is no policy layer
    // left to override it; the only reason to refuse is that the local catalog
    // does not have the model, in which case running something else silently
    // would be worse than failing.
    const route = this.taskRouter.resolveModel(explicitModel, explicitReasoning, true);
    if (!route) {
      console.warn(`[OpenCodex Subagent] Child model is not available in the local catalog: ${explicitModel || "(none named)"}`);
      return null;
    }
    const task = this.subagentOrchestrator.start({
      task_id: taskId,
      parent_task_id:
        metadata.parent_task_id ||
        metadata.parentThreadId ||
        metadata.parent_thread_id ||
        body?.parent_task_id ||
        body?.parent_thread_id ||
        headerMetadata.parent_thread_id ||
        headerMetadata.parent_task_id ||
        requestHeader(req, "x-codex-parent-thread-id"),
      provider: route.provider,
      model: route.model,
      backend_model: route.backend_model,
      reasoning_effort: route.reasoning_effort,
    });
    console.log(`[OpenCodex Subagent] Routed child task: ${route.model}${route.reasoning_effort ? ` reasoning=${route.reasoning_effort}` : ""} (explicit child model)`);
    const selectedRoute = { model: route.model, reasoning_effort: route.reasoning_effort, reason: "explicit child model", task_id: task.id };
    if (taskId !== "__active__") {
      this.subagentRouteBindings.set(taskId, { expiresAt: now + SUBAGENT_ROUTE_BINDING_TTL_MS, route: selectedRoute });
      while (this.subagentRouteBindings.size > MAX_SUBAGENT_ROUTE_BINDINGS) {
        const oldest = this.subagentRouteBindings.keys().next().value;
        if (!oldest) break;
        this.subagentRouteBindings.delete(oldest);
      }
    }
    return selectedRoute;
  }

  private acquireServerLock(): void {
    const lockPath = path.join(this.dataDir, `gateway-${this.port}.lock`);
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, port: this.port, started_at: Date.now() }));
      this.serverLockFd = fd;
      this.serverLockPath = lockPath;
      return;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    let ownerPid: number | undefined;
    try {
      const owner = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      if (Number.isInteger(owner?.pid)) ownerPid = owner.pid;
    } catch {}

    if (ownerPid === process.pid) {
      throw new Error(`Gateway port ${this.port} is already owned by this process`);
    }
    if (ownerPid) {
      try {
        process.kill(ownerPid, 0);
        throw new Error(`Gateway port ${this.port} is already owned by PID ${ownerPid}`);
      } catch (error: any) {
        if (error?.message?.includes("already owned")) throw error;
        // The recorded owner is gone; remove only this stale lock and retry.
      }
    }

    try { fs.unlinkSync(lockPath); } catch {}
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, port: this.port, started_at: Date.now() }));
    this.serverLockFd = fd;
    this.serverLockPath = lockPath;
  }

  private releaseServerLock(): void {
    if (this.serverLockFd !== null) {
      try { fs.closeSync(this.serverLockFd); } catch {}
      this.serverLockFd = null;
    }
    if (this.serverLockPath) {
      try { fs.unlinkSync(this.serverLockPath); } catch {}
      this.serverLockPath = "";
    }
  }

  private isAdminAuthorized(req: http.IncomingMessage): boolean {
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
    if (credentialsMatch(bearer, this.adminToken)) return true;

    const cookieHeader = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
    const cookieToken = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("opencodex_admin="))
      ?.slice("opencodex_admin=".length) || "";
    return credentialsMatch(cookieToken, this.adminToken);
  }

  private requireAdmin(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (this.isAdminAuthorized(req)) return true;
    res.writeHead(401, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "WWW-Authenticate": "Bearer"
    });
    res.end(JSON.stringify({ error: "OpenCodex admin authentication required" }));
    return false;
  }

  /** Endpoints that can reach an upstream carrying the user's own credentials. */
  private isUpstreamReachingPath(pathname: string): boolean {
    return isResponsesCompactionPath(pathname)
      || pathname === "/v1/responses"
      || pathname === "/responses"
      || pathname === "/v1/images/generations"
      || pathname === "/images/generations";
  }

  /**
   * Refuse an upstream-reaching request that a web page made.
   *
   * Only /api/* was ever authenticated, while copyNativeRequestHeaders swaps a
   * missing or placeholder bearer for the real ChatGPT access token from
   * auth.json. A page in any tab could therefore POST here with
   * `Content-Type: text/plain` — a simple request, so no preflight to refuse —
   * and have it executed under the user's identity. CORS keeps the reply from
   * being read, so the exposure is blind request forgery rather than token
   * theft: someone else's page spending the user's quota and acting as them.
   *
   * Listening on 127.0.0.1 is no defence; a browser reaches loopback happily.
   * No legitimate caller here is a browser — Codex and the bridge send neither
   * header — so their presence alone is disqualifying.
   */
  private rejectBrowserOriginatedRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const header = (name: string): string => {
      const value = req.headers[name];
      if (Array.isArray(value)) return value[0] || "";
      return typeof value === "string" ? value : "";
    };
    if (!header("origin") && !header("sec-fetch-site") && !header("sec-fetch-mode")) return false;

    res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      error: "OpenCodex refuses browser-originated requests on this endpoint",
      hint: "这个入口只服务 Codex 与 provider bridge。若你在浏览器里看到这条消息，说明某个页面正尝试借用你的 Codex 登录态发起请求。",
    }));
    return true;
  }

  private issueAdminCookie(res: http.ServerResponse): void {
    res.setHeader("Set-Cookie", `opencodex_admin=${this.adminToken}; HttpOnly; SameSite=Strict; Path=/`);
  }

  private parseRawBuffer(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const MAX_BYTES = MAX_REQUEST_BYTES;
      req.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          req.destroy();
          reject(new Error("Request body exceeds limit"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        const rawBuffer = Buffer.concat(chunks);
        const contentEncoding = req.headers["content-encoding"] as string | null;
        try {
          const decompressed = RequestDecompressor.decompressBody(rawBuffer, contentEncoding);
          resolve(decompressed);
        } catch {
          resolve(rawBuffer);
        }
      });
      req.on("error", reject);
    });
  }

  private parseJsonBody(req: http.IncomingMessage): Promise<any> {
    return this.parseJsonRequest(req).then((request) => request.body);
  }

  private parseJsonRequest(req: http.IncomingMessage): Promise<{ body: any; rawBody: Buffer }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const MAX_BYTES = MAX_REQUEST_BYTES;
      req.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          req.destroy();
          reject(new Error("Request body exceeds limit"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          const rawBuffer = Buffer.concat(chunks);
          const contentEncoding = req.headers["content-encoding"] as string | null;
          const decompressed = RequestDecompressor.decompressBody(rawBuffer, contentEncoding);
          const str = decompressed.toString("utf-8");
          resolve({ body: str ? JSON.parse(str) : {}, rawBody: decompressed });
        } catch (err) {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  private stripReasoningSuffix(modelId: string): string {
    let clean = (modelId || "").trim();
    // These families use a level word inside the model name itself, so the
    // picker suffix must not be stripped from them. They are ordinary
    // API-key providers here; only their subscription import is gone.
    if (clean.includes("gemini") || clean.includes("grok") || clean.includes("antigravity")) {
      return clean;
    }
    for (const level of ["-minimal", "-low", "-medium", "-high", "-xhigh"]) {
      if (clean.endsWith(level)) {
        return clean.slice(0, -level.length);
      }
    }
    return clean;
  }

  private readImportedModelCatalog(): any[] {
    const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
    try {
      const data = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
      return Array.isArray(data.models) ? data.models : [];
    } catch {
      return [];
    }
  }

  private findCatalogMatches(rawModelName: string): any[] {
    const requested = this.stripReasoningSuffix(rawModelName).toLowerCase();
    if (!requested) return [];
    const catalog = this.readImportedModelCatalog();
    const knownSlugs = new Set(catalog.map((entry: any) => catalogModelSlug(entry).toLowerCase()).filter(Boolean));
    for (const entry of runtimeProviderCatalogEntries()) {
      if (!knownSlugs.has(catalogModelSlug(entry).toLowerCase())) catalog.push(entry);
    }
    const identityCandidates = (entry: any): string[] => [
      entry.slug, entry.model, entry.id
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase());
    const backendCandidates = (entry: any): string[] => [
      entry.backend_model, entry.display_name
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase());

    const exactIdentityMatches = catalog.filter((entry) => identityCandidates(entry).some((value) => value === requested));
    if (exactIdentityMatches.length > 0) return exactIdentityMatches;

    const exactBackendMatches = catalog.filter((entry) => backendCandidates(entry).some((value) => value === requested));
    if (exactBackendMatches.length > 0) return exactBackendMatches;

    if (requested.length >= 3) {
      // Accept a short UI alias such as "opus" only when it resolves to one
      // subscription provider. Ambiguous aliases deliberately do not guess.
      return catalog.filter((entry) => [...identityCandidates(entry), ...backendCandidates(entry)].some((value) => value.includes(requested)));
    }
    return [];
  }

  private findCatalogProvider(rawModelName: string, providers: ProviderConfig[]): ProviderConfig | null {
    const matches = this.findCatalogMatches(rawModelName);

    const providerNames = Array.from(new Set(matches
      .map((entry) => catalogModelOwner(entry))
      .filter(Boolean)));
    if (providerNames.length !== 1) return null;

    const providerName = providerNames[0];
    return providers.find((provider) => provider.name.toLowerCase() === providerName || provider.preset_id?.toLowerCase() === providerName)
      || { name: providerName, baseUrl: "", models: matches.map((entry) => String(entry.slug || entry.model || "")).filter(Boolean) };
  }

  private findCatalogBackendModel(rawModelName: string): string | null {
    const matches = this.findCatalogMatches(rawModelName);
    const owned = matches.find((entry) => catalogModelOwner(entry));
    if (!owned) return null;
    return String(owned.backend_model || owned.model || owned.slug || "").trim() || null;
  }

  private findCatalogProtocol(rawModelName: string, provider: ProviderConfig): string {
    const matches = this.findCatalogMatches(rawModelName);
    const owned = matches.find((entry) => catalogModelOwner(entry));
    const explicit = String(owned?.protocol || owned?.backend_protocol || "").trim().toLowerCase();
    if (explicit) return explicit;

    // OpenCode Go publishes some models through Anthropic Messages and the
    // rest through OpenAI Chat Completions. The provider's single base URL is
    // not enough to infer this, so keep the routing rule next to catalog
    // ownership instead of sending every model to `/chat/completions`.
    const providerId = String(provider.preset_id || provider.name || "").toLowerCase();
    const model = String(owned?.backend_model || owned?.model || rawModelName || "").toLowerCase();
    if (providerId === "opencode-go" || providerId === "opencode") {
      if (/^(qwen|qwen3|minimax-m)/.test(model)) return "anthropic";
    }
    return "";
  }

  private normalizeProviderModel(rawModelName: string, provider: ProviderConfig): string {
    const model = String(rawModelName || "").trim();
    const providerId = String(provider.preset_id || provider.name || "").toLowerCase();
    if (providerId === "opencode-go" || providerId === "opencode") {
      // The Codex catalog/UI may namespace imported models (`opencode/...` or
      // `opencode-go/...`), while OpenCode's API expects the bare model ID.
      return model.replace(/^opencode(?:-go)?\//i, "");
    }
    return model;
  }


  private isNativeCatalogModel(rawModelName: string): boolean {
    const requested = this.stripReasoningSuffix(rawModelName).toLowerCase();
    if (!requested) return false;
    const catalog = this.readImportedModelCatalog();
    const importedNative = catalog.some((entry: any) => {
      const owner = catalogModelOwner(entry);
      if (owner) return false;
      return [entry.slug, entry.model, entry.id]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .some((value) => value.trim().toLowerCase() === requested);
    });
    if (importedNative) return true;
    // Official models are allowed to bypass the provider catalog even when a
    // stale custom catalog file has not been written yet. Never classify an
    // owner-scoped third-party model as native here.
    return readOfficialModelMap().has(requested);
  }

  private async proxyNativeResponses(req: http.IncomingMessage, body: any | Buffer, res: http.ServerResponse, endpoint = "responses"): Promise<void> {
    const nativeResponsesEndpoint = "https://chatgpt.com/backend-api/codex/responses";
    const targetUrl = endpoint === "responses"
      ? nativeResponsesEndpoint
      : `${nativeResponsesEndpoint}/${String(endpoint).replace(/^responses\/?/i, "")}`;
    const forwardHeaders = copyNativeRequestHeaders(req, { localAdminToken: this.adminToken }, true);
    const requestBody = Buffer.isBuffer(body)
      ? body
      : typeof body === "string"
        ? body
        : JSON.stringify(body);

    try {
      const upstreamRes = await fetchUpstream(targetUrl, {
        method: "POST",
        headers: forwardHeaders,
        // Keep the decompressed JSON bytes unchanged. Undici's BodyInit type
        // does not include Node's Buffer type even though fetch accepts it at
        // runtime.
        body: requestBody as any,
        maxAttempts: 1,
        timeoutMs: 600_000,
        operation: endpoint === "responses" ? "native-responses" : "native-responses-compact",
      });
      const responseHeaders = copySafeResponseHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.status, responseHeaders);
      if (upstreamRes.body) {
        // @ts-ignore Node's fetch body is an async iterable at runtime.
        for await (const chunk of upstreamRes.body) {
          await writeHttpResponseChunked(res, chunk);
        }
      }
      res.end();
    } catch (err: any) {
      const details = upstreamErrorDetails(err);
      console.error(`[CodexBridge V2] Native Responses proxy error:`, {
        ...details,
        attempts: err?.attempts,
      });
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: err.message,
          type: "upstream_unreachable",
          retryable: Boolean(err?.retryable),
          attempts: err?.attempts,
          cause_code: details.code,
        }));
      }
    }
  }

  private async proxyNativeImages(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse): Promise<void> {
    const nativeImagesEndpoint = "https://chatgpt.com/backend-api/codex/images/generations";
    const forwardHeaders = copyNativeRequestHeaders(req, { localAdminToken: this.adminToken }, true);

    try {
      const upstreamRes = await fetchUpstream(nativeImagesEndpoint, {
        method: "POST",
        headers: forwardHeaders,
        // The native Images API request body is forwarded unchanged after the
        // gateway removes transport compression, just like native Responses.
        body: body as any,
        maxAttempts: 1,
        timeoutMs: 600_000,
        operation: "native-images",
      });
      const responseHeaders = copySafeResponseHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.status, responseHeaders);
      if (upstreamRes.body) {
        // @ts-ignore Node's fetch body is an async iterable at runtime.
        for await (const chunk of upstreamRes.body) {
          await writeHttpResponseChunked(res, chunk);
        }
      }
      res.end();
    } catch (err: any) {
      const details = upstreamErrorDetails(err);
      console.error(`[CodexBridge V2] Native Images proxy error:`, {
        ...details,
        attempts: err?.attempts,
      });
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: err.message,
          type: "upstream_unreachable",
          retryable: Boolean(err?.retryable),
          attempts: err?.attempts,
          cause_code: details.code,
        }));
      }
    }
  }

  private async handleCompactionRequest(
    req: http.IncomingMessage,
    body: any,
    res: http.ServerResponse,
    rawBody?: Buffer,
  ): Promise<void> {
    const rawRequestedModel = body?.model || "deepseek-v4-pro";
    const requestedModel = this.stripReasoningSuffix(String(rawRequestedModel));
    const providers = CredentialStore.loadProviders();
    const nativeModel = this.isNativeCatalogModel(requestedModel);
    const provider = nativeModel ? null : this.findCatalogProvider(requestedModel, providers);

    if (!provider && nativeModel) {
      // The native provider owns compaction. The gateway only selects the
      // compact endpoint and forwards the request bytes unchanged.
      await this.proxyNativeResponses(req, rawBody ?? body, res, "responses/compact");
      return;
    }

    if (!provider) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: `Model "${rawRequestedModel}" is not present in an imported provider catalog; no compaction provider was selected`,
      }));
      return;
    }

    const apiKey = CredentialStore.resolveApiKey(provider);
    const rawUrl = (provider as any).baseUrl || (provider as any).base_url || (provider as any).url || "https://opencode.ai/zen/go/v1";
    const catalogModel = this.findCatalogBackendModel(requestedModel) || requestedModel;
    const upstreamModel = this.normalizeProviderModel(catalogModel, provider);
    const protocol = body?.protocol || this.findCatalogProtocol(requestedModel, provider);
    if (String(protocol || "").toLowerCase() !== "responses") {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: `Provider model "${rawRequestedModel}" does not expose the native Responses compaction endpoint`,
        type: "compaction_unsupported",
      }));
      return;
    }

    // A Responses-capable third-party provider owns its own compaction. The
    // gateway only translates the backend model name and forwards the native
    // compact request. There is intentionally no summary or envelope fallback.
    const nativeCompaction = await this.router.proxyNativeThirdPartyCompaction(
      { ...body, model: upstreamModel, protocol },
      upstreamModel,
      requestedModel,
      apiKey,
      rawUrl,
      res,
    );
    if (nativeCompaction === "unsupported" && !res.headersSent) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: `Provider model "${rawRequestedModel}" does not expose the native Responses compaction endpoint`,
        type: "compaction_unsupported",
      }));
    }
  }

  /**
   * Is anything listening on this port, and is it us?
   *
   * A bare TCP connect only proves the port is taken. The gateway must tell
   * its own instance apart from an unrelated program: the first case means
   * "already running, do nothing", the second means "find another port".
   */
  private inspectPort(port: number): Promise<"free" | "ours" | "foreign"> {
    // A raw socket rather than fetch(): a listener that accepts the connection
    // and then says nothing must time out here, and only the socket timeout is
    // guaranteed to fire for that case.
    return new Promise((resolve) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" });
      let received = "";
      let settled = false;
      const settle = (value: "free" | "ours" | "foreign") => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(1200);
      socket.once("error", () => settle("free"));
      socket.once("timeout", () => settle("foreign"));
      socket.once("connect", () => {
        socket.write(`GET /health HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      });
      socket.on("data", (chunk) => {
        received += chunk.toString("utf-8");
        if (received.includes("CodexBridge Engine V2")) settle("ours");
        else if (received.length > 8192) settle("foreign");
      });
      socket.once("close", () => settle(received.includes("CodexBridge Engine V2") ? "ours" : "foreign"));
    });
  }

  /**
   * Pick the port to listen on.
   *
   * An explicitly configured port is honoured or refused — never silently
   * changed, because the user chose it. The default may step aside for an
   * unrelated program so that a machine which already uses 8765 still works.
   */
  private async resolvePort(): Promise<number> {
    const explicit = Boolean(String(process.env.OPENCODEX_PORT || process.env.PORT || "").trim());
    const state = await this.inspectPort(this.port);
    if (state === "free") return this.port;
    if (state === "ours") {
      throw new Error(`An OpenCodex gateway is already running on port ${this.port}.`);
    }
    if (explicit) {
      throw new Error(
        `Port ${this.port} is held by another program. Set OPENCODEX_PORT to a free port, or stop that program.`,
      );
    }
    for (let candidate = this.port + 1; candidate < this.port + 10; candidate += 1) {
      if (await this.inspectPort(candidate) === "free") {
        console.warn(`[CodexBridge V2] Port ${this.port} is in use by another program; using ${candidate} instead.`);
        return candidate;
      }
    }
    throw new Error(`Port ${this.port} is in use and no free port was found in the following ten.`);
  }

  public async start(overridePort?: number): Promise<void> {

    if (overridePort && typeof overridePort === "number") {
      this.port = overridePort;
    }
    // Resolve before the lock: the lock file is named after the port.
    this.port = await this.resolvePort();
    this.acquireServerLock();
    const configPath = codexConfigPath();
    let managedConfig = "";
    try { managedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : ""; } catch {}
    const startupCatalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
    let startupCatalog: any = { models: [] };
    if (fs.existsSync(startupCatalogPath)) {
      try { startupCatalog = JSON.parse(fs.readFileSync(startupCatalogPath, "utf-8")); } catch {}
    }
    const startupHasThirdPartyModels = hasThirdPartyModels(CredentialStore.loadProviders(), startupCatalog);
    if (managedConfig.includes("opencodex managed") && !startupHasThirdPartyModels) {
      try {
        managedConfig = buildCodexRoutingConfig(managedConfig, this.port, this.adminToken, startupCatalogPath, false);
        fs.writeFileSync(configPath, managedConfig, "utf-8");
        console.log("[OpenCodex Gateway] Removed stale managed routing; native Codex remains active because no third-party models are selected.");
      } catch (err: any) {
        console.warn(`[OpenCodex Gateway] Could not remove stale managed routing: ${err?.message || err}`);
      }
    }
    // Native mode deliberately leaves the imported catalog untouched. In
    // managed mode, always repair the catalog first so native Codex models
    // cannot disappear just because a third-party entry was deleted.
    if (managedConfig.includes("opencodex managed")) {
      try {
        const configuredProviders = CredentialStore.loadProviders();
        const metadataChanged = await CatalogSyncService.refreshConfiguredProviderMetadata(configuredProviders);
        if (metadataChanged) {
          CredentialStore.saveProviders(configuredProviders);
          this.config.providers = configuredProviders;
        }
        const synchronizedConfig = buildManagedCodexConfig(managedConfig, this.port, this.adminToken);
        if (synchronizedConfig !== managedConfig) {
          fs.writeFileSync(configPath, synchronizedConfig, "utf-8");
          console.log(`[OpenCodex Gateway] Synchronized managed Codex config to port ${this.port} before startup.`);
        }
      } catch (err: any) {
        console.warn(`[OpenCodex Gateway] Could not synchronize managed Codex config: ${err?.message || err}`);
      }
      const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
      let catalog: any = { models: [] };
      if (fs.existsSync(catalogPath)) {
        try { catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")); } catch {}
      }
      if (!Array.isArray(catalog.models)) catalog.models = [];
      const before = JSON.stringify(catalog.models);
      preserveOfficialModels(catalog);

      if (before !== JSON.stringify(catalog.models)) {
        try {
          fs.mkdirSync(path.dirname(catalogPath), { recursive: true, mode: 0o700 });
          fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), { encoding: "utf-8", mode: 0o600 });
          try { fs.chmodSync(catalogPath, 0o600); } catch {}
        } catch (err: any) {
          // A read-only test/container home must not prevent the gateway from
          // starting. The next writable start will persist the repair.
          console.warn(`[OpenCodex Gateway] Could not persist model catalog repair: ${err?.message || err}`);
        }
      }
      // Preserve/restore the provider catalog first, then mirror the final
      // catalog into Codex's cache. The previous order synced the stale cache
      // before preserveOfficialModels could restore missing provider entries.
      CatalogSyncService.syncCustomModelsToCodexCache();

      // Codex may refresh models_cache.json while the desktop client is
      // booting. Mirror the final catalog once more after that refresh window
      // so a restart cannot replace the provider models with the native list.
      const delayedCatalogSync = setTimeout(() => {
        try {
          const latestConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
          if (latestConfig.includes("opencodex managed")) {
            CatalogSyncService.syncCustomModelsToCodexCache();
          }
        } catch (error: any) {
          console.warn(`[OpenCodex Catalog] Delayed Codex model cache sync failed: ${error?.message || error}`);
        }
      }, 2000);
      delayedCatalogSync.unref?.();
    }
    return new Promise(async (resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

        // Handle WebSocket Upgrade HTTP requests with 426 Upgrade Required (triggers codex-rs HTTP fallback)
        if (req.headers.upgrade?.toLowerCase() === "websocket" || (req.headers.connection || "").toLowerCase().includes("upgrade")) {
          if (url.pathname.includes("realtime") || url.pathname.includes("audio") || url.pathname.startsWith("/v1/live/")) {
            // Handled by server.on("upgrade") for transparent proxying to api.openai.com
            return;
          }
          res.writeHead(426, {
            "Content-Type": "application/json",
            "Sec-WebSocket-Version": "13",
            "Connection": "close",
          });
          res.end(JSON.stringify({ error: { message: "Responses WebSocket transport is disabled; use HTTP", type: "upgrade_required" } }));
          return;
        }

        // 1. Handshake / Healthcheck & Dashboard UI
        if (req.method === "GET" && url.pathname === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", name: "CodexBridge Engine V2", version: "2.1.0", opencodex: true }));
          return;
        }

        // The dashboard establishes a same-origin, HttpOnly admin cookie;
        // other local clients use the same token through Authorization:
        // Bearer. Keep every local-data and process-control API behind that
        // boundary.
        if (url.pathname.startsWith("/api/") && !this.requireAdmin(req, res)) {
          return;
        }

        // Everything below can reach ChatGPT or a provider with credentials
        // the caller never supplied, so no browser may drive it.
        if (this.isUpstreamReachingPath(url.pathname) && this.rejectBrowserOriginatedRequest(req, res)) {
          return;
        }

        // Native OpenAI Realtime / Audio / Voice transparent HTTP proxy
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
          const { getDashboardHtml } = await import("../services/dashboard/index.js");
          this.issueAdminCookie(res);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(getDashboardHtml());
          return;
        }

        // 2. Responses compaction. Codex uses /responses/compact for remote
        // compaction v2. Ordinary /responses requests stay on the ordinary
        // native route and are never reclassified by the gateway.
        if (req.method === "POST" && isResponsesCompactionPath(url.pathname)) {
          try {
            const request = await this.parseJsonRequest(req);
            await this.handleCompactionRequest(req, request.body, res, request.rawBody);
          } catch (err: any) {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          }
          return;
        }

        // Native Images API compatibility. Codex Desktop addresses the
        // built-in image tool through `/v1/images/generations`; keep it on the
        // native lane and forward its decompressed request bytes unchanged to
        // the native Codex Images API. It must not enter provider routing or
        // the third-party image bridge.
        if (req.method === "POST" && (url.pathname === "/v1/images/generations" || url.pathname === "/images/generations")) {
          try {
            const rawBody = await this.parseRawBuffer(req);
            await this.proxyNativeImages(req, rawBody, res);
          } catch (err: any) {
            if (!res.headersSent) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          }
          return;
        }

        // 3. V2 Core: Responses API (/v1/responses)
        if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
          let subagentTaskId = "";
          try {
            const request = await this.parseJsonRequest(req);
            const body = request.body;
            const isSubagentRequest = this.isSubagentResponsesRequest(body, req);
            const requestedModelBeforeRouting = this.stripReasoningSuffix(String(body?.model || ""));
            const nativeModelRequest = Boolean(requestedModelBeforeRouting)
              && this.isNativeCatalogModel(requestedModelBeforeRouting);
            const nativePassthroughTurn = isNativeCodexPassthrough(nativeModelRequest, isSubagentRequest);
            const subagentRoute = isSubagentRequest ? this.chooseSubagentRoute(body, req) : null;
            // Only a third-party child needs a gateway route. An official model
            // reaching this path — Codex opening a new session or spawning a
            // child on GPT — has nothing to route and must stay on the native
            // lane; failing it closed here rejected legitimate official work
            // with "No available subagent route was selected by the gateway".
            if (isSubagentRequest && !subagentRoute && !nativePassthroughTurn) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                error: "No available subagent route was selected by the gateway",
              }));
              return;
            }
            if (subagentRoute) {
              // The gateway-owned spawn_agent dispatcher uses these headers to
              // report the one route selected here. Keeping this metadata at
              // the HTTP boundary prevents the dispatcher from resolving the
              // same child a second time before it reaches /v1/responses.
              res.setHeader("x-opencodex-subagent-task-id", subagentRoute.task_id || "");
              res.setHeader("x-opencodex-subagent-model", subagentRoute.model || "");
              if (subagentRoute.reasoning_effort) {
                res.setHeader("x-opencodex-subagent-reasoning-effort", subagentRoute.reasoning_effort);
              }
              if (subagentRoute.profile_id) {
                res.setHeader("x-opencodex-subagent-profile-id", subagentRoute.profile_id);
              }
            }
            // A routed child receives its task as an `agent_message` whose
            // payload is a Fernet token only the ChatGPT backend can read, so a
            // third-party model is handed an empty assignment and reports that
            // it was given no task. Recover the plaintext when the oracle is
            // enabled; otherwise fail loudly rather than run a child blind.
            if (subagentRoute && !nativePassthroughTurn && hasEncryptedAgentMessage(body)) {
              const accountId = requestHeader(req, "chatgpt-account-id");
              const outcome = agentMessageOracleEnabled()
                ? await resolveEncryptedAgentMessages(body, accountId)
                : { encrypted: 1, resolved: 0 };
              if (outcome.resolved < outcome.encrypted) {
                console.warn("[OpenCodex Subagent] Child task payload is encrypted for the ChatGPT backend and could not be recovered.");
                res.writeHead(502, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  error: {
                    type: "unreadable_encrypted_agent_task",
                    message: agentMessageOracleEnabled()
                      ? "The subagent task payload could not be decrypted; the child was not started with an empty task."
                      : "The subagent task payload is encrypted for the ChatGPT backend. Set OPENCODEX_AGENT_MESSAGE_ORACLE=1 to recover it through your own Codex credentials, or keep the child on an official model.",
                  },
                }));
                return;
              }
              console.log(`[OpenCodex Subagent] Recovered ${outcome.resolved} encrypted child task payload(s) for ${subagentRoute.model}.`);
            }
            // Native GPT turns are transport-only even while the gateway is
            // active. The one deliberate exception is a native child turn:
            // the gateway may inspect that boundary to select a configured
            // subagent model. Once selected, native targets still use the
            // native proxy and third-party targets use the provider router.
            subagentTaskId = subagentRoute?.task_id || "";
            const selectedWorkRoute = subagentRoute;
            let effectiveBody = body;
            if (selectedWorkRoute) {
              const selectedModel = this.stripReasoningSuffix(String(selectedWorkRoute.model || ""));
              const thirdPartyWorkRoute = Boolean(selectedModel) && !this.isNativeCatalogModel(selectedModel);
              effectiveBody = { ...body, model: selectedWorkRoute.model };
              if (thirdPartyWorkRoute) {
                // The parent native turn may carry an effort such as `max`
                // that the selected provider does not understand. The route
                // resolver has already normalized it against the target
                // catalog; never leak the inherited native value downstream.
                delete effectiveBody.reasoning;
                delete effectiveBody.reasoning_effort;
                if (selectedWorkRoute.reasoning_effort) {
                  effectiveBody.reasoning = { effort: selectedWorkRoute.reasoning_effort };
                  effectiveBody.reasoning_effort = selectedWorkRoute.reasoning_effort;
                }
                if (isSubagentRequest) {
                  // A worker no longer receives the nested spawn control after
                  // runtime tool filtering, so keep its provider turn
                  // sequential. The parent native turn retains its own
                  // parallel_tool_calls value untouched.
                  effectiveBody.parallel_tool_calls = false;
                }
              } else if (selectedWorkRoute.reasoning_effort) {
                effectiveBody.reasoning = { ...(body.reasoning || {}), effort: selectedWorkRoute.reasoning_effort };
                effectiveBody.reasoning_effort = selectedWorkRoute.reasoning_effort;
              }
            }
            if (selectedWorkRoute?.model && body.model !== selectedWorkRoute.model) {
              console.log(`[OpenCodex Routing] Applied selected work model: ${body.model || "(default)"} -> ${selectedWorkRoute.model}`);
            }
            console.log(`[CodexBridge V2 DEBUG] POST /v1/responses body keys:`, Object.keys(effectiveBody), "model:", effectiveBody.model);
            // Opt-in capture for diagnosing what actually reaches a provider.
            // Enabled with OPENCODEX_DEBUG_REQUEST_DUMP=<directory>; each request
            // lands in its own file so a subagent turn can be inspected without
            // reproducing it through the UI a second time.
            this.dumpRequestForDebug(effectiveBody, req);
            const rawRequestedModel = effectiveBody.model || "deepseek-v4-pro";
            const requestedModel = this.stripReasoningSuffix(rawRequestedModel);
            const providers = CredentialStore.loadProviders();
            // Subscription imports are the source of truth. A model may only
            // use the provider recorded beside it in the imported catalog.
            // Official ownerless GPT models must win before any third-party
            // backend alias is considered; otherwise a custom provider that
            // happens to expose the same raw slug could steal native routing.
            const nativeModel = this.isNativeCatalogModel(requestedModel);
            const provider = nativeModel ? null : this.findCatalogProvider(requestedModel, providers);

            if (!provider) {
              if (nativeModel) {
                // Keep the native GPT lane transparent. No body-level
                // translation, reasoning rewrite, or provider fallback is
                // allowed here.
                const nativeRawBody = effectiveBody === body ? request.rawBody : undefined;
                await this.proxyNativeResponses(req, nativeRawBody ?? effectiveBody, res);
                if (subagentTaskId) this.subagentOrchestrator.complete(subagentTaskId);
                return;
              }
              if (subagentTaskId) this.subagentOrchestrator.fail(subagentTaskId, "selected subagent model is not present in an imported provider catalog");
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                error: `Model "${rawRequestedModel}" is not present in an imported provider catalog; no fallback provider was selected`
              }));
              return;
            }

            const apiKey = CredentialStore.resolveApiKey(provider);
            const rawUrl = (provider as any).baseUrl || (provider as any).base_url || (provider as any).url || "https://opencode.ai/zen/go/v1";
            const catalogModel = this.findCatalogBackendModel(requestedModel) || requestedModel;
            const upstreamModel = this.normalizeProviderModel(catalogModel, provider);
            const protocol = effectiveBody.protocol || this.findCatalogProtocol(requestedModel, provider);
            const normalizedReasoning = this.taskRouter.normalizeReasoningEffort(
              requestedModel,
              effectiveBody?.reasoning?.effort || effectiveBody?.reasoning_effort,
              true,
            );
            const routingBody = protocol ? { ...effectiveBody, protocol } : { ...effectiveBody };
            delete routingBody.reasoning;
            delete routingBody.reasoning_effort;
            if (normalizedReasoning) {
              routingBody.reasoning = { effort: normalizedReasoning };
              routingBody.reasoning_effort = normalizedReasoning;
            }
            const providerUrl = rawUrl;

            const nativeImageHeaders = copyNativeRequestHeaders(req, { localAdminToken: this.adminToken }, true);
            await this.router.handleResponses(
              routingBody,
              upstreamModel,
              apiKey,
              providerUrl,
              res,
              provider.name,
              nativeImageHeaders,
              requestedModel,
              isSubagentRequest,
            );
            if (subagentTaskId) this.subagentOrchestrator.complete(subagentTaskId);
          } catch (err: any) {
            if (subagentTaskId) this.subagentOrchestrator.fail(subagentTaskId, err?.message || "subagent request failed");
            if (!res.headersSent) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            }
          }
          return;
        }

        // 3. Dashboard REST API Routes
        if (req.method === "GET" && url.pathname === "/api/gateway/status") {
          const configPath = codexConfigPath();
          let active = false;
          if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, "utf-8");
            active = content.includes("opencodex managed");
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ active }));
          return;
        }

        // 1.1.0 Agent Profile and routing APIs. Profiles are user-owned
        // policy data; the imported model catalog remains a separate derived
        // inventory and is never rewritten by these endpoints.
        if (req.method === "GET" && url.pathname === "/api/agent-tasks") {
          const limit = Number(url.searchParams.get("limit") || 100);
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ tasks: this.subagentOrchestrator.list(limit) }));
          return;
        }

        const agentTaskPathMatch = url.pathname.match(/^\/api\/agent-tasks\/([^/]+)\/cancel$/);
        if (agentTaskPathMatch && req.method === "POST") {
          const task = this.subagentOrchestrator.requestCancel(decodeURIComponent(agentTaskPathMatch[1]));
          res.writeHead(task ? 200 : 404, { "Content-Type": "application/json" });
          res.end(JSON.stringify(task ? { task, note: "已记录取消请求；原生 Desktop 子任务是否立即停止由 Desktop 生命周期决定" } : { error: "子任务不存在" }));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/providers/presets") {
          const presets = [
            // deepseek-v4-pro is deliberately absent: DeepSeek's server still
            // rejects it for Codex integration, and a preset reads as a
            // verified recommendation. It can be added by hand once that
            // changes.
            { id: "deepseek", label: "DeepSeek", defaultBaseUrl: "https://api.deepseek.com/", iconSlug: "deepseek", models: [{ id: "deepseek-v4-flash" }] },
            { id: "qwen", label: "通义千问 (Qwen)", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", iconSlug: "qwen", models: [{ id: "qwen-max" }, { id: "qwen-plus" }] },
            { id: "minimax", label: "MiniMax", defaultBaseUrl: "https://api.minimaxi.com/v1", iconSlug: "minimax", models: [{ id: "minimax-m3" }] },
            { id: "kimi", label: "Kimi (Moonshot)", defaultBaseUrl: "https://api.moonshot.cn/v1", iconSlug: "kimi", models: [{ id: "moonshot-v1-8k" }] },
            { id: "custom", label: "自定义兼容接口", defaultBaseUrl: "", iconSlug: "", models: [] },
            { id: "openrouter", label: "OpenRouter", defaultBaseUrl: "https://openrouter.ai/api/v1", iconSlug: "openrouter", models: [{ id: "anthropic/claude-3.5-sonnet" }] },
            { id: "opencode-go", label: "OpenCode Go", defaultBaseUrl: "https://opencode.ai/zen/go/v1", iconSlug: "", models: [{ id: "opencode-go-pro" }] },
            { id: "siliconflow", label: "SiliconFlow (硅基流动)", defaultBaseUrl: "https://api.siliconflow.cn/v1", iconSlug: "", models: [{ id: "deepseek-ai/DeepSeek-V3" }] },
            { id: "volcengine", label: "火山方舟 (Volcengine)", defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3", iconSlug: "", models: [{ id: "ep-20241201-xxxx" }] }
          ];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ presets }));
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/providers") {
          const configPath = codexConfigPath();
          let isGatewayActive = false;
          if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, "utf-8");
            isGatewayActive = content.includes("opencodex managed");
          }

          const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
          let catalogModels: any[] = [];
          if (fs.existsSync(catalogPath)) {
            try {
              const cat = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
              catalogModels = cat.models || [];
            } catch {}
          }


          const apiProviders = CredentialStore.loadProviders().map((p: any) => {
            const hasApiKey = Boolean(CredentialStore.resolveApiKey(p));
            // providers.json is the durable source of the selected model
            // list. The catalog is a derived view and may be stale after
            // Codex refreshes its native cache during a restart.
            const effectiveModels = Array.isArray(p.models) ? p.models : [];
            const hasActiveModel = effectiveModels.length > 0;

            const status = hasActiveModel || hasApiKey ? "configured" : "not_configured";

            const { api_key: _apiKey, api_key_env: _apiKeyEnv, refresh_token: _refreshToken, ...safeProvider } = p;
            return {
              ...safeProvider,
              models: effectiveModels,
              id: p.name,
              api_key_configured: hasApiKey,
              status,
              test_status: p.last_test_status || "untested",
              credential_storage: hasApiKey ? (p.credential_ref ? "keychain" : "local-secure-store") : "none",
              active_models: effectiveModels.map((m: string) => {
                const raw = String(m);
                const alias = raw.includes("=") ? raw.split("=")[0] : raw.includes("->") ? raw.split("->")[0] : raw;
                const catalogModel = catalogModels.find((cm: any) =>
                  catalogModelOwner(cm) === normalizeNamespace(p.name)
                  && [cm.slug, cm.id, cm.display_name, cm.backend_model].filter(Boolean).some((value: any) => String(value) === alias)
                );
                return {
                  id: catalogModel?.slug || namespaceModelSlug(p.name, alias),
                  enabled: true,
                  protocol: catalogModel?.protocol || catalogModel?.backend_protocol || protocolForConfiguredModel(raw, p.model_protocols),
                };
              })
            };
          });

          const providers = apiProviders;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ providers }));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/providers") {
          try {
            const body = await this.parseJsonBody(req);
            const requestedProviderName = String(body.name || body.preset_id || "custom").trim().toLowerCase();
            const presetId = String(body.preset_id || requestedProviderName).trim().toLowerCase();
            const baseUrl = String(body.base_url || "").trim();
            const apiKey = String(body.api_key || "").trim();
            const selectedModels: string[] = Array.isArray(body.selected_models) ? body.selected_models : [];
            const selectedModelProtocols = buildModelProtocolMap(
              selectedModels,
              body.model_protocols && typeof body.model_protocols === "object" ? body.model_protocols : undefined,
              body.model_protocol,
            );

            let providers = CredentialStore.loadProviders();
            let provider = providers.find((p: any) => p.name === requestedProviderName)
              || providers.find((p: any) => p.preset_id === presetId);
            const previousProviderName = normalizeNamespace(provider?.name || "");
            const providerName = deriveProviderNamespace(
              presetId === "custom" ? "custom" : (provider?.preset_id || requestedProviderName),
              baseUrl
            );
            let resolvedProviderName = providerName;
            if (!provider) {
              const conflict = providers.find((p: any) => normalizeNamespace(p.name) === resolvedProviderName);
              if (conflict && providerUrlFingerprint((conflict as any).baseUrl || (conflict as any).base_url) !== providerUrlFingerprint(baseUrl)) {
                resolvedProviderName = `${resolvedProviderName}-${stableShortHash(providerUrlFingerprint(baseUrl))}`;
              }
            } else if (provider.preset_id === "custom" && previousProviderName !== resolvedProviderName) {
              const conflict = providers.find((p: any) => p !== provider && normalizeNamespace(p.name) === resolvedProviderName);
              if (conflict && providerUrlFingerprint((conflict as any).baseUrl || (conflict as any).base_url) !== providerUrlFingerprint(baseUrl)) {
                resolvedProviderName = `${resolvedProviderName}-${stableShortHash(providerUrlFingerprint(baseUrl))}`;
              }
            }
            if (!provider) {
              provider = {
                name: resolvedProviderName,
                preset_id: presetId,
                baseUrl,
                models: selectedModels,
                model_protocols: selectedModelProtocols,
              };
              providers.push(provider);
            } else {
              provider.baseUrl = baseUrl || provider.baseUrl;
              provider.name = resolvedProviderName;
              provider.preset_id = presetId;
              // The dashboard sends the complete current list. Replace the
              // stored list so removals and edits are reflected on reopen.
              provider.models = Array.from(new Set(selectedModels));
              provider.model_protocols = selectedModelProtocols;
            }

            // Saving or changing configuration invalidates the previous connectivity result.
            provider.last_test_status = "untested";
            delete provider.last_test_at;
            delete provider.last_test_message;

            if (apiKey) {
              // Use the exact list being saved. The credential store may
              // still cache the pre-create list during a first-time save.
              CredentialStore.setApiKeyOnProviders(providers, resolvedProviderName, apiKey);
            }
            // Refresh only capability metadata here. The configured model
            // list remains exactly what the user submitted; /models and the
            // live registry fill context/reasoning facts without guessing from
            // a model name.
            try {
              const liveDescriptors = await CatalogSyncService.fetchLiveModels(provider);
              const discoveredMetadata = CatalogSyncService.modelMetadataMap(provider, liveDescriptors);
              if (Object.keys(discoveredMetadata).length > 0) {
                provider.model_metadata = CatalogSyncService.mergeProviderModelMetadata(provider.model_metadata, discoveredMetadata);
              }
            } catch (metadataError: any) {
              console.warn(`[OpenCodex Catalog] capability refresh skipped: ${metadataError?.message || metadataError}`);
            }
            CredentialStore.saveProviders(providers);

            // Update custom model catalog if install_models is true.
            // Remove models previously owned by this provider but omitted from
            // the latest list, otherwise the next edit resurrects them.
            if (body.install_models !== false) {
              const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
              let catalog: any = { models: [] };
              if (fs.existsSync(catalogPath)) {
                try { catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")); } catch {}
              }
              if (!Array.isArray(catalog.models)) catalog.models = [];
              migrateProviderCatalogOwner(catalog, previousProviderName, resolvedProviderName);
              preserveOfficialModels(catalog);

              rebuildProviderCatalogModels(catalog, resolvedProviderName, selectedModels, selectedModelProtocols, provider);

              preserveOfficialModels(catalog);
              fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf-8");

              // Enable or remove the managed block according to the final
              // selected-model state. Saving credentials alone must not route
              // native Codex traffic through the gateway.
              const configPath = codexConfigPath();
              if (fs.existsSync(configPath)) {
                let content = fs.readFileSync(configPath, "utf-8");
                fs.writeFileSync(
                  configPath,
                  buildCodexRoutingConfig(content, this.port, this.adminToken, catalogPath, hasThirdPartyModels(providers, catalog)),
                  "utf-8",
                );
              }
              // The catalog file is the source of truth, but Codex's desktop
              // picker reads its local model cache on the next launch. Keep
              // the cache in sync at the same moment the provider is saved.
              CatalogSyncService.syncCustomModelsToCodexCache();
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", provider }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }


        if (req.method === "POST" && url.pathname === "/api/providers/test-model") {
          try {
            const body = await this.parseJsonBody(req);
            const presetId = String(body.preset_id || body.name || "").trim().toLowerCase();
            const modelInput = String(body.model || "").trim();
            const model = modelInput.includes("=")
              ? modelInput.split("=").slice(1).join("=").trim()
              : modelInput.includes("->")
                ? modelInput.split("->").slice(1).join("->").trim()
                : modelInput;
            const protocol = body.protocol === "responses" ? "responses" : "chat";
            let baseUrl = String(body.base_url || body.baseUrl || "").trim();
            let apiKey = String(body.api_key || body.apiKey || "").trim();

            try {
              const found = CredentialStore.loadProviders().find((p: any) => p.name === presetId || p.preset_id === presetId);
              if (found) {
                baseUrl = baseUrl || String((found as any).baseUrl || (found as any).base_url || "");
                apiKey = apiKey || String(CredentialStore.resolveApiKey(found) || "");
              }
            } catch {}

            if (!presetId || !model || !baseUrl) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "failed", message: "缺少服务商、Endpoint 或模型名称" }));
              return;
            }
            if (!apiKey || apiKey === "grok-cli-auto" || apiKey === "antigravity-cli-auto") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "failed", message: "未找到 API Key，请先填写或保存 API Key" }));
              return;
            }

            const providerBaseUrl = baseUrl
              .replace(/\/(?:chat\/completions|messages|responses)\/?$/i, "")
              .replace(/\/$/, "");
            const targetUrl = `${providerBaseUrl}/${protocol === "responses" ? "responses" : "chat/completions"}`;
            const testBody = protocol === "responses"
              ? { model, input: "Reply with OK.", stream: false, store: false, max_output_tokens: 16 }
              : { model, messages: [{ role: "user", content: "Reply with OK." }], stream: false, max_tokens: 16 };
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 20_000);

            try {
              const testRes = await fetch(targetUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify(testBody),
                signal: controller.signal
              });
              const responseText = await testRes.text();
              clearTimeout(timer);
              if (!testRes.ok) {
                const detail = responseText.replace(/\s+/g, " ").trim().slice(0, 600);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "failed", message: `${protocol === "responses" ? "Responses" : "Chat"} 测试失败 (HTTP ${testRes.status})${detail ? `：${detail}` : ""}` }));
                return;
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "connected", message: `${protocol === "responses" ? "Responses" : "Chat"} 测试成功，模型已返回响应` }));
              return;
            } catch (netErr: any) {
              clearTimeout(timer);
              const message = netErr?.name === "AbortError" ? "模型测试超时 (20s)" : (netErr?.message || "模型测试网络失败");
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "failed", message: `模型测试失败：${message}` }));
              return;
            }
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "failed", message: err.message }));
          }
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/providers/test") {
          try {
            const body = await this.parseJsonBody(req);
            const providerName = String(body.name || body.preset_id || "").trim().toLowerCase();
            let baseUrl = body.base_url || body.baseUrl;
            let apiKey = body.api_key || body.apiKey;

            const finishTest = (status: ProviderTestStatus, message: string) => {
              recordProviderTest(providerName, status, message);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status, message }));
            };

            try {
              const found = CredentialStore.loadProviders().find((p: any) => p.name === providerName || p.preset_id === providerName);
              if (found) {
                baseUrl = baseUrl || (found as any).baseUrl || (found as any).base_url;
                apiKey = apiKey || CredentialStore.resolveApiKey(found);
              }
            } catch {}

            if (!providerName) {
              finishTest("failed", "缺少服务商名称");
              return;
            }

            if (!baseUrl) {
              finishTest("failed", "未配置 Endpoint / Base URL");
              return;
            }

            const cleanUrl = baseUrl.replace(/\/$/, "");
            const testTargetUrl = cleanUrl.endsWith("/models") ? cleanUrl : `${cleanUrl}/models`;

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);

            try {
              const testRes = await fetch(testTargetUrl, {
                method: "GET",
                headers: {
                  ...(apiKey && apiKey !== "grok-cli-auto" && apiKey !== "antigravity-cli-auto" ? { Authorization: `Bearer ${apiKey}` } : {})
                },
                signal: controller.signal
              });
              clearTimeout(timer);

              // Only a 2xx means the endpoint answered as a model listing.
              // Everything except 401/403 used to fall through to "connected",
              // so a wrong Base URL (404), a rate limit (429) or an upstream
              // outage (5xx) all reported success and only failed later, on a
              // real request.
              finishTest(...describeProviderTestStatus(testRes.status));
              return;
            } catch (netErr: any) {
              clearTimeout(timer);
              const isTimeout = netErr.name === "AbortError";
              const errMsg = isTimeout ? "连接超时 (6s)" : (netErr.message || "网络握手失败");
              finishTest("failed", `无法连接到服务商 Endpoint (${baseUrl}): ${errMsg}`);
              return;
            }
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "failed", message: err.message }));
          }
          return;
        }





        if (req.method === "POST" && url.pathname === "/api/restart-codex") {
          if (this.gatewayRestartInProgress) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Gateway restart already in progress", retryable: true }));
            return;
          }
          this.gatewayRestartInProgress = true;
          try {
            const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
            const configPath = codexConfigPath();

            let catalog: any = { models: [] };
            if (fs.existsSync(catalogPath)) {
              try { catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8")); } catch {}
            }
            const hasModels = hasThirdPartyModels(CredentialStore.loadProviders(), catalog);

            if (fs.existsSync(configPath)) {
              let content = fs.readFileSync(configPath, "utf-8");
              fs.writeFileSync(
                configPath,
                buildCodexRoutingConfig(content, this.port, this.adminToken, catalogPath, hasModels),
                "utf-8",
              );
              CatalogSyncService.syncCustomModelsToCodexCache();
              console.log(`[OpenCodex Gateway] Applied ${hasModels ? "managed gateway" : "native"} Codex routing before restart.`);
            }

            // Codex reads model_catalog_json only when the desktop process
            // starts. Stop the desktop before the gateway restart and let the
            // new gateway launch it after startup has repaired the catalog.
            // Launching it here races the PM2 restart and makes native-only
            // models appear permanently until another manual restart.
            this.requestDesktopLaunchAfterGatewayReady();
            this.desktop.stopDesktopClients();

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", message: "桌面端与网关服务正在重新启动..." }));

            setTimeout(() => {
              try {
                execFileSync("/opt/homebrew/bin/pm2", ["restart", "opencodex"], { stdio: "ignore" });
              } catch {
                // Keep the current gateway usable if PM2 is unavailable. The
                // old process already has the final config/catalog, so it is
                // safe to consume the marker and relaunch the desktop here.
                try { fs.unlinkSync(this.desktopRestartMarkerPath); } catch {}
                this.desktop.launchDesktopClient(true);
                this.gatewayRestartInProgress = false;
              }
            }, 300);
            return;
          } catch (err: any) {
            this.gatewayRestartInProgress = false;
            console.error("[OpenCodex Gateway] Restart error:", err?.message);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "success", message: "桌面端与网关服务正在重新启动..." }));
          return;
        }

        if (req.method === "GET" && (url.pathname === "/assets/opencodex-logo.png" || url.pathname === "/assets/opencodex-logo-compact.png")) {
          const logoFile = url.pathname.endsWith("-compact.png") ? "opencodex-logo-compact.png" : "opencodex-logo.png";
          const possiblePaths = [
            path.join(process.cwd(), "src_v2", "assets", logoFile),
            path.join(process.cwd(), "dist", "src_v2", "assets", logoFile),
            path.join(os.homedir(), "projects", "opencodex", "src_v2", "assets", logoFile)
          ];
          const found = possiblePaths.find((p) => fs.existsSync(p));
          if (found) {
            res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
            res.end(fs.readFileSync(found));
          } else {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Logo not found");
          }
          return;
        }

        if (req.method === "GET" && url.pathname === "/api/models") {
          const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
          let catalog: any[] = [];
          if (fs.existsSync(catalogPath)) {
            try {
              const data = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
              const before = JSON.stringify(data.models || []);
              preserveOfficialModels(data);
              if (before !== JSON.stringify(data.models || [])) {
                fs.writeFileSync(catalogPath, JSON.stringify(data, null, 2), "utf-8");
              }
              // Official native models are not web-managed models. They stay
              // in the desktop catalog, but only provider-owned entries are
              // exposed here for third-party management.
              catalog = (data.models || []).filter((m: any) => Boolean(catalogModelOwner(m)));
            } catch {}
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ catalog }));
          return;
        }

        if (req.method === "GET" && url.pathname.startsWith("/api/logs")) {
          const logFiles = [
            { path: path.join(os.homedir(), ".pm2", "logs", "opencodex-out.log"), level: "info", source: "gateway" },
            { path: path.join(os.homedir(), ".pm2", "logs", "opencodex-error.log"), level: "error", source: "gateway" }
          ];
          const entries: Array<{ time: string; level: string; text: string; source: string }> = [];
          for (const file of logFiles) {
            const lines = readLogTail(file.path, 192 * 1024);
            let time = new Date().toLocaleTimeString();
            try { time = new Date(fs.statSync(file.path).mtimeMs).toLocaleTimeString(); } catch {}
            for (const line of lines.slice(-160)) {
              const text = redactLogLine(line).slice(0, 4000);
              if (/Written helper python scripts to \/tmp successfully\.?$/i.test(text.trim())) continue;
              const level = /successfully|running|ready|listening|started|written helper/i.test(text) && !/error|failed|exception|syntax error/i.test(text)
                ? "info"
                : file.level;
              entries.push({ time, level, source: file.source, text });
            }
          }
          const compacted: Array<{ time: string; level: string; text: string; source: string }> = [];
          const counts = new Map<string, number>();
          for (const entry of entries.slice(-300)) {
            const key = `${entry.level}|${entry.text}`;
            const previous = counts.get(key) || 0;
            counts.set(key, previous + 1);
            if (previous === 0) compacted.push(entry);
          }
          for (const entry of compacted) {
            const count = counts.get(`${entry.level}|${entry.text}`) || 1;
            if (count > 1) entry.text = `${entry.text}（重复 ${count} 次）`;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ entries: compacted }));
          return;
        }

        // Delete model endpoint
        if (req.method === "POST" && url.pathname === "/api/models/delete") {
          try {
            const body = await this.parseJsonBody(req);
            const id = body.id;
            const ids: string[] = Array.isArray(body.ids) ? body.ids : (id ? [id] : []);

            const providers = CredentialStore.loadProviders();
            let providersChanged = false;
            for (const provider of providers as any[]) {
              const nextModels = (provider.models || []).filter((model: string) => {
                const raw = String(model);
                const alias = raw.includes("=") ? raw.split("=")[0] : raw.includes("->") ? raw.split("->")[0] : raw;
                const namespaced = namespaceModelSlug(provider.name, alias.trim());
                return !ids.includes(raw) && !ids.includes(alias.trim()) && !ids.includes(namespaced);
              });
              if (nextModels.length !== (provider.models || []).length) {
                provider.models = nextModels;
                const nextProtocols: Record<string, ModelProtocol> = {};
                for (const model of nextModels) {
                  const { slug } = splitConfiguredModel(model);
                  if (slug) nextProtocols[slug] = protocolForConfiguredModel(model, provider.model_protocols);
                }
                provider.model_protocols = nextProtocols;
                providersChanged = true;
              }
            }
            if (providersChanged) CredentialStore.saveProviders(providers);

            const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
            let catalog: any = { models: [] };
            if (fs.existsSync(catalogPath)) {
              catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
              if (Array.isArray(catalog.models)) {
                preserveOfficialModels(catalog);
                catalog.models = catalog.models.filter((model: any) => {
                  // Native Codex models are immutable from the web manager.
                  if (!catalogModelOwner(model)) return true;
                  return ![model.id, model.slug, model.model, model.backend_model]
                    .filter(Boolean)
                    .some((value: any) => ids.includes(String(value)));
                });
                preserveOfficialModels(catalog);
                fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf-8");
                CatalogSyncService.syncCustomModelsToCodexCache();
              }
            }
            const gatewayActive = hasThirdPartyModels(providers, catalog);
            if (!gatewayActive) {
              const configPath = codexConfigPath();
              if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, "utf-8");
                fs.writeFileSync(configPath, buildCodexRoutingConfig(content, this.port, this.adminToken, catalogPath, false), "utf-8");
              }
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", deleted: ids, gateway_active: gatewayActive }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        // Delete provider endpoint
        if (req.method === "POST" && url.pathname === "/api/providers/delete") {
          try {
            const body = await this.parseJsonBody(req);
            const providerName = body.name || body.id;
            let providers = CredentialStore.loadProviders();
            const removedProviders = providers.filter((p: any) => p.name === providerName || p.id === providerName);
            providers = providers.filter((p: any) => p.name !== providerName && p.id !== providerName);
            CredentialStore.saveProviders(providers);
            // Drop the credential too; otherwise a removed provider leaves a
            // usable API key behind in the OS secret store.
            for (const removed of removedProviders) CredentialStore.forgetProviderSecret(removed);

            const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
            let catalog: any = { models: [] };
            if (fs.existsSync(catalogPath)) {
              try {
                catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
                if (Array.isArray(catalog.models)) {
                  catalog.models = catalog.models.filter((model: any) =>
                    String(model.backend_provider || model.provider_name || "").toLowerCase() !== String(providerName).toLowerCase()
                  );
                  preserveOfficialModels(catalog);
                  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf-8");
                  CatalogSyncService.syncCustomModelsToCodexCache();
                }
              } catch {}
            }
            const gatewayActive = hasThirdPartyModels(providers, catalog);
            if (!gatewayActive) {
              const configPath = codexConfigPath();
              if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, "utf-8");
                fs.writeFileSync(configPath, buildCodexRoutingConfig(content, this.port, this.adminToken, catalogPath, false), "utf-8");
              }
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", deleted: providerName, gateway_active: gatewayActive }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }


        if (req.method === "GET" && url.pathname === "/api/native-egress") {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ enabled: nativeEgressEnabled(this.dataDir) }));
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/native-egress") {
          try {
            const body = await this.parseJsonBody(req);
            const enabled = body?.enabled !== false;
            fs.mkdirSync(this.dataDir, { recursive: true });
            fs.writeFileSync(nativeEgressSettingPath(this.dataDir), JSON.stringify({ enabled }, null, 2), "utf-8");
            // The bridge reads this from the environment Desktop passes down,
            // so republish it and let the caller restart Desktop.
            if (this.registeredProviderBridge) this.desktop.registerProviderBridgeEnvironment(this.port);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ enabled, restart_required: true }));
          } catch (err: any) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        // Leave OpenCodex entirely: undo everything that makes Codex Desktop
        // route through this project, so a broken gateway or bridge cannot
        // keep Codex broken with it.
        if (req.method === "POST" && url.pathname === "/api/disengage") {
          try {
            const configPath = codexConfigPath();
            if (fs.existsSync(configPath)) {
              const content = fs.readFileSync(configPath, "utf-8");
              fs.writeFileSync(configPath, `${stripManagedCodexConfig(content)}\n`, "utf-8");
            }
            // The decisive step, and the one plain "restore native" never did:
            // while CODEX_CLI_PATH points here, Desktop keeps launching the
            // bridge no matter what the config says.
            this.desktop.unregisterProviderBridgeEnvironment();
            this.registeredProviderBridge = false;
            const rollouts = repairNativeRollouts();
            this.restartDesktop(true);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              status: "success",
              rollouts,
              message: "Codex 已脱离 OpenCodex：环境变量已注销、托管配置已移除、Desktop 正在重启。第三方模型与凭据都保留，重新启动网关即可恢复。"
                + `会话修复：检查 ${rollouts.inspected} 个，改写 ${rollouts.repaired} 个（原文件已留 .opencodex-backup 备份），其余 ${rollouts.skipped} 个未改动。`,
            }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/reset") {
          try {
            // Native restore keeps the configured provider credentials and
            // endpoints, but must remove every selected third-party model.
            // Otherwise the dashboard rebuilds the pending list from the
            // durable providers.json on the next load.
            const clearedProviders = clearProviderModelSelections(CredentialStore.loadProviders());
            CredentialStore.saveProviders(clearedProviders);
            this.config.providers = clearedProviders;

            const configPath = codexConfigPath();
            if (fs.existsSync(configPath)) {
              let content = fs.readFileSync(configPath, "utf-8");
              // Removing OpenCodex is not a reason to change which official
              // model the user had chosen. This used to force `model` to a
              // pinned "gpt-5.5", overwriting their selection and, on an
              // account that no longer offers that slug, leaving new sessions
              // failing after what looked like a clean restore.
              content = stripManagedCodexConfig(content);
              fs.writeFileSync(configPath, content + "\n", "utf-8");
            }
            const catalogPath = path.join(os.homedir(), ".opencodex", "custom_model_catalog.json");
            if (fs.existsSync(catalogPath)) {
              fs.writeFileSync(catalogPath, JSON.stringify({ models: [] }), "utf-8");
            }
            CatalogSyncService.syncCustomModelsToCodexCache();

            // Third-party V2 responses used to emit local rs_* reasoning items.
            // Remove those persisted records before the native desktop client
            // sends this thread back to chatgpt.com.
            const rollouts = repairNativeRollouts();

            // Without this the Desktop keeps launching the bridge even though
            // the managed config is gone, so "restore native" was never a
            // complete way out.
            this.desktop.unregisterProviderBridgeEnvironment();
            this.registeredProviderBridge = false;

            this.restartDesktop(true);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "success", gateway_active: false, rollouts }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Endpoint not found" }));
      });

      // The gateway speaks HTTP only. Codex must never be left holding a
      // half-open upgrade, so every attempt is answered and closed.
      this.server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        if (url.pathname.includes("responses")) {
          socket.write("HTTP/1.1 426 Upgrade Required\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":{\"message\":\"Responses WebSocket transport is disabled; use HTTP\",\"type\":\"upgrade_required\"}}");
          socket.destroy();
          return;
        }

        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
      });

      this.server.on("error", (err) => {
        console.error(`[CodexBridge V2] Server error: ${err.message}`);
        this.releaseServerLock();
        reject(err);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        console.log(`[CodexBridge V2] Server listening on http://127.0.0.1:${this.port}`);
        // A hand-set OPENCODEX_NATIVE_EGRESS becomes the stored setting, so
        // the environment escape hatch survives the publish that follows.
        try { adoptNativeEgressOverride(this.dataDir); } catch (error: any) {
          console.warn(`[OpenCodex Gateway] Could not adopt the native-egress override: ${error?.message || error}`);
        }
        // Publish the bridge environment only once the port is actually held.
        // Registering earlier meant a second gateway could overwrite a healthy
        // instance's variables and then clear them entirely when it exited on
        // EADDRINUSE, silently detaching Desktop from the running bridge.
        if (this.desktop.registerProviderBridgeEnvironment(this.port)) {
          this.registeredProviderBridge = true;
          if (this.desktop.desktopAppServerState() !== "bridge") {
            this.requestDesktopLaunchAfterGatewayReady();
          } else {
            console.log("[OpenCodex Gateway] Desktop is already attached to the provider bridge; gateway startup will not restart it.");
          }
        }
        // GPT-Live's floating picker is opt-in. Do not relaunch a persisted
        // picker just because the DMG/gateway has started; the settings POST
        // below is the explicit user action that starts it.
        this.launchDesktopAfterGatewayReadyIfRequested();
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      // Cancel before anything else: a pending launch would otherwise restart
      // Desktop after the gateway that scheduled it had already gone away.
      if (this.desktopLaunchTimer) {
        clearTimeout(this.desktopLaunchTimer);
        this.desktopLaunchTimer = null;
      }
      if (this.registeredProviderBridge) {
        this.registeredProviderBridge = false;
        this.desktop.unregisterProviderBridgeEnvironment();
      }
      if (this.server) {
        this.server.close(() => {
          this.releaseServerLock();
          void closeUpstreamDispatcher().finally(resolve);
        });
      } else {
        this.releaseServerLock();
        void closeUpstreamDispatcher().finally(resolve);
      }
    });
  }
}

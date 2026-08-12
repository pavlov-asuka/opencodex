import fs from "node:fs";
import path from "node:path";
import { codexHomePath } from "../platform/paths.js";
import os from "node:os";

export interface RoutingCatalogModel {
  slug: string;
  backend_model: string;
  provider: string;
  display_name?: string;
  protocol?: string;
  context_window?: number;
  max_context_window?: number;
  context_window_source?: "provider_metadata" | "model_registry" | "unknown";
  context_window_confidence?: "exact" | "unknown";
  metadata_source?: string;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
  default_reasoning_level?: string;
  /**
   * Lowest effort this model may ever be run at. Unlike the default level,
   * which only fills in a missing value, this also raises an effort the client
   * asked for explicitly — the way to pin a cheap third-party model to its
   * deepest setting regardless of what the Desktop picker carries over.
   */
  min_reasoning_level?: string;
  reasoning?: boolean;
  available: boolean;
  catalog_source: "custom" | "native";
}

export const DEFAULT_REASONING_EFFORTS = ["low", "medium", "high"] as const;
const DEFAULT_REASONING_LEVELS = DEFAULT_REASONING_EFFORTS.map((effort) => ({ effort }));

function clean(value: unknown, max = 400): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function lower(value: unknown): string {
  return clean(value, 400).toLowerCase();
}

/**
 * Relative depth of the effort names Codex uses. Only values listed here can be
 * compared; an unknown name is left untouched rather than guessed at, so a
 * future level cannot be silently downgraded to a floor.
 */
const REASONING_EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
};

/** Raise an effort to the model's floor, when the model declares one. */
export function applyReasoningFloor(model: RoutingCatalogModel, effort?: string): string | undefined {
  const floor = lower(model.min_reasoning_level);
  if (!floor) return effort;
  // Never send a level the model does not advertise: the provider would reject
  // the turn, which is worse than running at the requested depth.
  const supported = (model.supported_reasoning_levels || []).map((level) => lower(level.effort));
  if (!supported.includes(floor)) return effort;
  if (!effort) return floor;
  const floorRank = REASONING_EFFORT_RANK[floor];
  const currentRank = REASONING_EFFORT_RANK[lower(effort)];
  if (floorRank === undefined || currentRank === undefined) return effort;
  return currentRank < floorRank ? floor : effort;
}

function normalizeReasoningForModel(model: RoutingCatalogModel, requestedValue?: string, preserveExplicit = false): string | undefined {
  return applyReasoningFloor(model, resolveReasoningForModel(model, requestedValue, preserveExplicit));
}

function resolveReasoningForModel(model: RoutingCatalogModel, requestedValue?: string, preserveExplicit = false): string | undefined {
  const declaredSupported = (model.supported_reasoning_levels || [])
    .map((level) => lower(level.effort))
    .filter(Boolean);

  // Keep an explicit provider enum authoritative even when a broad
  // `reasoning: false` flag is also present. Only an explicit false with no
  // returned levels means that this model is automatic-only.
  if (model.reasoning === false && declaredSupported.length === 0) return undefined;
  const supported = declaredSupported.length > 0
    ? declaredSupported
    : DEFAULT_REASONING_LEVELS.map((level) => level.effort);

  const requested = lower(requestedValue);
  if (requested && supported.includes(requested)) return requested;
  // The value may come from the Desktop/Web picker rather than from a saved
  // Profile. In that case do not silently turn an explicit `max`/`xhigh` into
  // the model's default merely because an older local catalog is incomplete.
  // The provider remains the authority: if it rejects the value, the gateway
  // records the returned enum and refreshes the shared catalog.
  if (requested && preserveExplicit) return requested;

  if (supported.length === 0) return undefined;

  const declaredDefault = lower(model.default_reasoning_level);
  if (declaredDefault && supported.includes(declaredDefault)) return declaredDefault;
  return supported[0];
}

function catalogValue(entry: any, keys: string[]): string {
  for (const key of keys) {
    const value = clean(entry?.[key], 300);
    if (value) return value;
  }
  return "";
}

function catalogPositiveNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

function catalogContextValue(entry: any, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = catalogPositiveNumber(entry?.[key]);
    if (value) return value;
  }
  for (const container of [entry?.limit, entry?.limits, entry?.capabilities?.limit, entry?.capabilities?.limits]) {
    if (!container || typeof container !== "object") continue;
    for (const key of keys) {
      const value = catalogPositiveNumber(container[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function modelFromEntry(entry: any, source: "custom" | "native"): RoutingCatalogModel | null {
  const slug = catalogValue(entry, ["slug", "id", "model"]);
  const backendModel = catalogValue(entry, ["backend_model", "backendModel", "model", "slug", "id"]);
  if (!slug || !backendModel) return null;
  const rawReasoningLevels = entry?.supported_reasoning_levels
    ?? entry?.supportedReasoningEfforts
    ?? entry?.supported_reasoning_efforts
    ?? entry?.reasoning_efforts
    ?? entry?.reasoningEfforts
    ?? entry?.reasoning_levels
    ?? entry?.reasoningLevels;
  const reasoningLevels = Array.isArray(rawReasoningLevels)
    ? rawReasoningLevels
      .map((item: any) => ({
        effort: clean(item?.effort ?? item?.reasoning_effort ?? item?.reasoningEffort ?? item?.value ?? item, 40),
        description: clean(item?.description, 300) || undefined,
      }))
      .filter((item: any) => item.effort)
    : undefined;
  const rawDefaultReasoning = entry?.default_reasoning_level
    ?? entry?.defaultReasoningEffort
    ?? entry?.defaultReasoningLevel;
  const defaultReasoning = typeof rawDefaultReasoning === "object"
    ? clean(rawDefaultReasoning?.effort ?? rawDefaultReasoning?.reasoningEffort, 40)
    : clean(rawDefaultReasoning, 40);
  const rawMinReasoning = entry?.min_reasoning_level
    ?? entry?.minimum_reasoning_level
    ?? entry?.min_reasoning_effort
    ?? entry?.minReasoningEffort;
  const minReasoning = typeof rawMinReasoning === "object"
    ? lower(rawMinReasoning?.effort ?? rawMinReasoning?.reasoningEffort)
    : lower(rawMinReasoning);
  const reasoning = typeof entry?.reasoning === "boolean" ? entry.reasoning : undefined;
  const contextWindow = catalogContextValue(entry, ["context_window", "contextWindow", "context_length", "contextLength"]);
  const maxContextWindow = catalogContextValue(entry, ["max_context_window", "maxContextWindow", "max_context_length", "maxContextLength"]);
  const contextSource = ["provider_metadata", "model_registry", "unknown"].includes(String(entry?.context_window_source || "").trim().toLowerCase())
    ? String(entry.context_window_source).trim().toLowerCase() as "provider_metadata" | "model_registry" | "unknown"
    : undefined;
  const contextConfidence = ["exact", "unknown"].includes(String(entry?.context_window_confidence || "").trim().toLowerCase())
    ? String(entry.context_window_confidence).trim().toLowerCase() as "exact" | "unknown"
    : undefined;
  const effectiveReasoningLevels = reasoning === false
    ? (reasoningLevels || [])
      : reasoningLevels && reasoningLevels.length > 0
      ? [
        ...DEFAULT_REASONING_LEVELS.map((level) => reasoningLevels.find((declared) => declared.effort.toLowerCase() === level.effort) || level),
        ...reasoningLevels.filter((declared) => !DEFAULT_REASONING_LEVELS.some((level) => declared.effort.toLowerCase() === level.effort)),
      ]
      : DEFAULT_REASONING_LEVELS;
  const effectiveDefaultReasoning = effectiveReasoningLevels && effectiveReasoningLevels.length > 0
    ? (effectiveReasoningLevels.some((level) => level.effort.toLowerCase() === defaultReasoning.toLowerCase())
      ? defaultReasoning
      : effectiveReasoningLevels.some((level) => level.effort === "medium")
        ? "medium"
        : effectiveReasoningLevels[0].effort)
    : undefined;
  return {
    slug,
    backend_model: backendModel,
    provider: lower(catalogValue(entry, ["backend_provider", "provider", "owner"]) || (source === "native" ? "native" : "")),
    display_name: catalogValue(entry, ["display_name", "displayName", "name"]) || undefined,
    protocol: catalogValue(entry, ["protocol", "backend_protocol"]) || undefined,
    ...(contextWindow ? { context_window: contextWindow } : {}),
    ...(maxContextWindow ? { max_context_window: maxContextWindow } : {}),
    ...(contextSource ? { context_window_source: contextSource } : {}),
    ...(contextConfidence ? { context_window_confidence: contextConfidence } : {}),
    ...(typeof entry?.metadata_source === "string" && entry.metadata_source.trim()
      ? { metadata_source: entry.metadata_source.trim() }
      : {}),
    supported_reasoning_levels: effectiveReasoningLevels,
    default_reasoning_level: effectiveDefaultReasoning,
    ...(minReasoning && effectiveReasoningLevels.some((level) => level.effort.toLowerCase() === minReasoning)
      ? { min_reasoning_level: minReasoning }
      : {}),
    reasoning,
    available: entry?.available !== false,
    catalog_source: source,
  };
}

export function readRoutingCatalog(
  dataDir = process.env.OPENCODEX_DATA_DIR || path.join(os.homedir(), ".opencodex"),
  nativeDataDir = codexHomePath(),
): RoutingCatalogModel[] {
  const sources: Array<{ filePath: string; source: "custom" | "native" }> = [
    // This is Codex's existing model capability interface/cache. It carries
    // the exact per-model reasoning options returned by the native catalog.
    { filePath: path.join(nativeDataDir, "models_cache.json"), source: "native" },
    // Keep the older filename as a compatibility fallback for installations
    // that still publish the catalog under this name.
    { filePath: path.join(nativeDataDir, "models_catalog.json"), source: "native" },
    { filePath: path.join(dataDir, "custom_model_catalog.json"), source: "custom" },
  ];
  const result = new Map<string, RoutingCatalogModel>();
  for (const source of sources) {
    let payload: any;
    try { payload = JSON.parse(fs.readFileSync(source.filePath, "utf-8")); } catch { continue; }
    const entries = Array.isArray(payload) ? payload : payload?.models;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const model = modelFromEntry(entry, source.source);
      if (!model) continue;
      // Native models are mirrored into custom_model_catalog.json when the
      // gateway is managed. Merge duplicate capability records instead of
      // letting a stale Desktop cache hide a newly imported extra level such
      // as DeepSeek `max` from the Web routing directory.
      if (model.slug.toLowerCase() === "codex-auto-review") continue;
      const key = model.slug.toLowerCase();
      const previous = result.get(key);
      if (!previous) {
        result.set(key, model);
        continue;
      }
      const levels = new Map<string, { effort: string; description?: string }>();
      for (const level of previous.supported_reasoning_levels || []) levels.set(level.effort.toLowerCase(), level);
      for (const level of model.supported_reasoning_levels || []) {
        const normalizedEffort = level.effort.toLowerCase();
        if (!levels.has(normalizedEffort) || level.description) levels.set(normalizedEffort, level);
      }
      const mergedLevels = Array.from(levels.values());
      const mergedDefault = [model.default_reasoning_level, previous.default_reasoning_level]
        .map((value) => lower(value))
        .find((value) => value && mergedLevels.some((level) => level.effort.toLowerCase() === value));
      result.set(key, {
        ...previous,
        ...model,
        supported_reasoning_levels: mergedLevels,
        ...(mergedDefault ? { default_reasoning_level: mergedDefault } : {}),
      });
    }
  }
  return Array.from(result.values()).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** What a resolved child turn needs to reach its provider. */
export interface ResolvedModelRoute {
  model: string;
  backend_model: string;
  provider: string;
  protocol?: string;
  reasoning_effort?: string;
  catalog_model: RoutingCatalogModel;
}

/**
 * Reads the model catalog and answers two questions about a concrete model:
 * whether it exists, and what reasoning effort it should run at.
 *
 * There is deliberately no policy here. Which model a turn uses is decided by
 * the client — the Desktop picker for a main turn, the explicitly named model
 * for a spawn_agent child.
 */
export class TaskRouter {
  public readonly dataDir: string;

  constructor(dataDir = process.env.OPENCODEX_DATA_DIR || path.join(os.homedir(), ".opencodex")) {
    this.dataDir = dataDir;
  }

  public listModels(): RoutingCatalogModel[] {
    return readRoutingCatalog(this.dataDir);
  }

  /**
   * Resolve an explicitly named model against the local catalog.
   * `null` means the catalog does not have it, which is the one case where a
   * child turn must fail rather than silently run on something else.
   */
  public resolveModel(modelValue: string, requestedEffort?: string, preserveExplicit = false): ResolvedModelRoute | null {
    const requested = lower(modelValue);
    if (!requested) return null;
    const model = this.listModels().find((entry) =>
      entry.slug.toLowerCase() === requested ||
      entry.backend_model.toLowerCase() === requested ||
      entry.display_name?.toLowerCase() === requested,
    );
    if (!model || !model.available) return null;
    const reasoning = normalizeReasoningForModel(model, requestedEffort, preserveExplicit && Boolean(clean(requestedEffort, 40)));
    return {
      model: model.slug,
      backend_model: model.backend_model,
      provider: model.provider,
      protocol: model.protocol,
      reasoning_effort: reasoning || undefined,
      catalog_model: model,
    };
  }

  /**
   * Normalize a parent/native reasoning value for a concrete target model.
   * A parent turn can advertise `max` while a child only accepts low/medium/
   * high, or has no selectable effort enum at all. In both cases the target
   * model must win: use its declared default/first level, or omit the field
   * when the catalog says the model is automatic-only.
   */
  public normalizeReasoningEffort(modelValue: string, requestedValue?: string, preserveExplicit = false): string | undefined {
    const requested = lower(modelValue);
    const model = this.listModels().find((entry) =>
      entry.slug.toLowerCase() === requested ||
      entry.backend_model.toLowerCase() === requested ||
      entry.display_name?.toLowerCase() === requested,
    );
    if (!model) return clean(requestedValue, 40) || undefined;
    return normalizeReasoningForModel(model, requestedValue, preserveExplicit);
  }

}

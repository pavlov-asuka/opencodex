import http from "node:http";
import { ResponsesStreamEngine } from "../core/stream_engine.js";
import { buildGatewaySubagentResponseTool, isSubagentDispatchToolName, stripSubagentRuntimeTools, transformResponsesToChat } from "../core/transformer.js";
import { AdapterFactory } from "../adapters/factory.js";
import { fetchUpstream, upstreamErrorDetails } from "../services/upstream_fetch.js";
import { extractImageGenerationContext, generateNativeCodexImage, parseImageGenerationArguments } from "../services/native_image_bridge.js";
import { appendComputerUseInstructions, hasComputerUseTool, hasNativeComputerUseTool, normalizeComputerUseResponsesTools, normalizeNativeComputerUseResponsesPayload } from "../services/computer_use_native.js";
import {
  hasChatToolImages,
  isConsoleGoToolImageRejection,
  isXiaomiChatToolTextRejection,
  isXiaomiMimoProvider,
  normalizeXiaomiChatToolHistory,
  stripChatToolImages,
} from "../services/chat_tool_compat.js";
import { optimizeThirdPartyComputerUseImages } from "../services/computer_use_image_compat.js";
import { isNativeResponsesReasoningId } from "../core/responses_safety.js";
import { copySafeResponseHeaders, writeHttpResponseChunked, writeSseData } from "../services/http_stream.js";
import { CatalogSyncService } from "../services/catalog_sync.js";

export interface GatewaySubagentDispatchCall {
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  thought_signature?: string;
}

export interface GatewaySubagentDispatchContext {
  parent_task_id?: string;
  parent_model?: string;
  provider?: string;
  backend_model?: string;
  parent_reasoning_effort?: string;
}

export interface GatewaySubagentDispatchResult {
  call_id: string;
  task_id?: string;
  model?: string;
  reasoning_effort?: string;
  output: string;
  error?: string;
}

export type GatewaySubagentDispatcher = (
  calls: GatewaySubagentDispatchCall[],
  context: GatewaySubagentDispatchContext,
) => Promise<GatewaySubagentDispatchResult[]>;




function responsesEndpointForProvider(providerUrl: string): string {
  const base = String(providerUrl || "").replace(/\/(?:chat\/completions|messages|responses)\/?$/i, "").replace(/\/$/, "");
  return `${base}/responses`;
}

function responsesCompactionEndpointForProvider(providerUrl: string): string {
  return `${responsesEndpointForProvider(providerUrl)}/compact`;
}

/**
 * A third-party provider that exposes /responses/compact receives the same
 * native compact request shape as GPT. Only the backend model name changes;
 * the provider must perform the compaction and return its native item.
 */
export function buildThirdPartyNativeCompactionBody(body: any, upstreamModel: string): any {
  const upstreamBody = { ...(body || {}), model: upstreamModel };
  // `protocol` is a gateway catalog hint, not an upstream Responses field.
  delete upstreamBody.protocol;
  return upstreamBody;
}

function isResponsesUnsupported(status: number, body: string): boolean {
  if (status === 404 || status === 405) return true;
  if (status !== 415) return false;
  return /response|protocol|endpoint|unsupported|not supported|not found/i.test(body);
}

function sanitizeThirdPartyResponsesPayload(
  payload: any,
  blockedReasoningIds: Set<string>,
  nativeComputerUseCallIds?: Set<string>,
): any | null {
  if (!payload || typeof payload !== "object") return payload;

  const item = payload.item;
  if (item?.type === "reasoning") {
    const id = typeof item.id === "string" ? item.id : "";
    if (!isNativeResponsesReasoningId(id)) {
      if (id) blockedReasoningIds.add(id);
      return null;
    }
  }

  const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
  if (itemId && blockedReasoningIds.has(itemId)) return null;
  if (itemId && /reasoning/i.test(String(payload.type || "")) && !isNativeResponsesReasoningId(itemId)) {
    blockedReasoningIds.add(itemId);
    return null;
  }

  if (payload.response && Array.isArray(payload.response.output)) {
    const output = payload.response.output.filter((outputItem: any) => {
      if (outputItem?.type !== "reasoning") return true;
      const id = typeof outputItem.id === "string" ? outputItem.id : "";
      if (isNativeResponsesReasoningId(id)) return true;
      if (id) blockedReasoningIds.add(id);
      return false;
    });
    payload = { ...payload, response: { ...payload.response, output } };
  }

  return normalizeNativeComputerUseResponsesPayload(payload, nativeComputerUseCallIds);
}

function rewriteThirdPartyResponseModel(payload: any, responseModel: string): any {
  if (!payload || typeof payload !== "object" || !responseModel) return payload;
  let next = payload;
  if (payload.response && typeof payload.response === "object") {
    next = { ...next, response: { ...payload.response, model: responseModel } };
  }
  if (typeof payload.model === "string") {
    next = { ...next, model: responseModel };
  }
  return next;
}

function sanitizeThirdPartySseEvent(
  event: string,
  blockedReasoningIds: Set<string>,
  nativeComputerUseCallIds?: Set<string>,
  responseModel = "",
): string | null {
  const lines = event.split(/\r?\n/);
  const dataIndexes: number[] = [];
  const dataLines: string[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("data:")) {
      dataIndexes.push(index);
      dataLines.push(line.slice(5).trimStart());
    }
  });
  if (dataLines.length === 0) return `${event}\n\n`;
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return `${event}\n\n`;

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return `${event}\n\n`; }
  const sanitized = rewriteThirdPartyResponseModel(
    sanitizeThirdPartyResponsesPayload(payload, blockedReasoningIds, nativeComputerUseCallIds),
    responseModel,
  );
  if (sanitized === null) return null;
  const output = JSON.stringify(sanitized);
  const rewritten = lines.map((line, index) => {
    if (!dataIndexes.includes(index)) return line;
    return `data: ${output}`;
  });
  return `${rewritten.join("\n")}\n\n`;
}

async function pipeFilteredThirdPartyResponses(
  body: AsyncIterable<Uint8Array>,
  res: http.ServerResponse,
  responseModel = "",
): Promise<void> {
  const decoder = new TextDecoder();
  const blockedReasoningIds = new Set<string>();
  const nativeComputerUseCallIds = new Set<string>();
  let buffer = "";
  const flush = async (final = false) => {
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = final ? "" : (chunks.pop() || "");
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const sanitized = sanitizeThirdPartySseEvent(chunk, blockedReasoningIds, nativeComputerUseCallIds, responseModel);
      if (sanitized) await writeHttpResponseChunked(res, sanitized);
    }
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    await flush();
  }
  buffer += decoder.decode();
  await flush(true);
}

type CollectedThirdPartyResponses = {
  events: string[];
  response?: any;
  calls: GatewaySubagentDispatchCall[];
  json?: any;
};

function responseFunctionCallFromItem(item: any): GatewaySubagentDispatchCall | null {
  const name = String(item?.name || "").trim();
  if (!item || item.type !== "function_call" || !isSubagentDispatchToolName(name)) return null;
  const callId = String(item.call_id || item.id || "").trim();
  if (!callId) return null;
  return {
    id: String(item.id || callId),
    call_id: callId,
    name,
    arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
    ...((item.thought_signature || item.thoughtSignature || item.signature)
      ? { thought_signature: String(item.thought_signature || item.thoughtSignature || item.signature) }
      : {}),
  };
}

function collectResponseFunctionCall(
  calls: Map<string, GatewaySubagentDispatchCall>,
  item: any,
): void {
  const call = responseFunctionCallFromItem(item);
  if (call) calls.set(call.call_id, call);
}

/**
 * Ceilings for a response held whole in memory.
 *
 * This function buffers every SSE event until the upstream finishes, so a long
 * reply, a tool loop, or an upstream that simply never stops grew the process
 * without limit. The caps are far above any real answer; crossing one means
 * the provider is misbehaving, and a clear protocol error beats an OOM.
 */
const MAX_COLLECTED_EVENT_BYTES = 64 * 1024 * 1024;
const MAX_COLLECTED_SINGLE_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_COLLECTED_ERROR_BODY_BYTES = 1 * 1024 * 1024;

export class ProviderResponseTooLargeError extends Error {
  constructor(limit: number, what: string) {
    super(`Provider response exceeded the ${what} limit of ${limit} bytes`);
    this.name = "ProviderResponseTooLargeError";
  }
}

/** Read a non-streaming body without trusting it to be a sane size. */
async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  // @ts-ignore Node's fetch body is an async iterable at runtime.
  for await (const chunk of response.body) {
    bytes += chunk.length ?? 0;
    if (bytes > limit) throw new ProviderResponseTooLargeError(limit, "error body");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function collectThirdPartyResponsesBody(response: Response): Promise<CollectedThirdPartyResponses> {
  const calls = new Map<string, GatewaySubagentDispatchCall>();
  const events: string[] = [];
  let collectedBytes = 0;

  const remember = (event: string): void => {
    if (event.length > MAX_COLLECTED_SINGLE_EVENT_BYTES) {
      throw new ProviderResponseTooLargeError(MAX_COLLECTED_SINGLE_EVENT_BYTES, "single event");
    }
    collectedBytes += event.length;
    if (collectedBytes > MAX_COLLECTED_EVENT_BYTES) {
      throw new ProviderResponseTooLargeError(MAX_COLLECTED_EVENT_BYTES, "accumulated response");
    }
    events.push(event);
  };

  let responseObject: any;
  const contentType = response.headers.get("content-type") || "";

  const observe = (raw: string): void => {
    const dataLines = raw.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") return;
    let payload: any;
    try { payload = JSON.parse(data); } catch { return; }
    if (payload?.response && typeof payload.response === "object") {
      responseObject = payload.response;
    }
    if (payload?.type === "response.output_item.added" || payload?.type === "response.output_item.done") {
      collectResponseFunctionCall(calls, payload.item);
    }
    if (payload?.type === "response.function_call_arguments.delta") {
      const itemId = String(payload.item_id || "").trim();
      const existing = Array.from(calls.values()).find((call) => call.id === itemId);
      if (existing) existing.arguments += String(payload.delta || "");
    }
    if (payload?.type === "response.completed" && Array.isArray(payload.response?.output)) {
      for (const item of payload.response.output) collectResponseFunctionCall(calls, item);
    }
  };

  if (!response.body || !contentType.toLowerCase().includes("text/event-stream")) {
    const raw = await readBoundedText(response, MAX_COLLECTED_ERROR_BODY_BYTES);
    let json: any;
    try { json = JSON.parse(raw); } catch { json = undefined; }
    const output = json?.response || json;
    if (output && typeof output === "object") {
      responseObject = output;
      for (const item of Array.isArray(output.output) ? output.output : []) collectResponseFunctionCall(calls, item);
    }
    return { events, response: responseObject, calls: Array.from(calls.values()), json };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  // @ts-ignore Node's fetch body is an async iterable at runtime.
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() || "";
    for (const event of chunks) {
      if (!event.trim()) continue;
      remember(event);
      observe(event);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    remember(buffer);
    observe(buffer);
  }
  return { events, response: responseObject, calls: Array.from(calls.values()) };
}

function buildThirdPartyResponsesSubagentContinuation(
  body: any,
  calls: GatewaySubagentDispatchCall[],
  results: GatewaySubagentDispatchResult[],
): any {
  const originalInput = Array.isArray(body?.input)
    ? body.input
    : body?.input
      ? [{ type: "message", role: "user", content: [{ type: "input_text", text: String(body.input) }] }]
      : [];
  const resultByCallId = new Map(results.map((result) => [result.call_id, result]));
  return {
    ...body,
    stream: true,
    input: [
      ...originalInput,
      ...calls.map((call) => ({
        type: "function_call",
        id: call.id,
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments,
        ...(call.thought_signature ? { thought_signature: call.thought_signature, thoughtSignature: call.thought_signature } : {}),
      })),
      ...calls.map((call) => {
        const result = resultByCallId.get(call.call_id);
        return {
          type: "function_call_output",
          call_id: call.call_id,
          output: result?.error ? `子代理执行失败：${result.error}` : result?.output || "子代理已完成，但没有返回文本。",
        };
      }),
    ],
  };
}

async function proxyThirdPartyResponses(
  reqBody: any,
  upstreamModel: string,
  responseModel: string,
  apiKey: string,
  providerUrl: string,
  res: http.ServerResponse,
  isSubagentRequest = false,
  subagentDispatcher: GatewaySubagentDispatcher | null = null,
  subagentContext: GatewaySubagentDispatchContext = {},
  providerName = "",
): Promise<"handled" | "fallback"> {
  const targetUrl = responsesEndpointForProvider(providerUrl);
  const optimized = await optimizeThirdPartyComputerUseImages(reqBody);
  const upstreamBody = {
    ...optimized.body,
    model: upstreamModel,
    ...(isSubagentRequest
      ? { tools: stripSubagentRuntimeTools(optimized.body?.tools) }
      : subagentDispatcher
        ? {
          tools: [
            ...(Array.isArray(optimized.body?.tools) ? optimized.body.tools : []),
            buildGatewaySubagentResponseTool(),
          ].filter((tool: any, index: number, list: any[]) => list.findIndex((candidate) => String(candidate?.name || candidate?.function?.name || "") === String(tool?.name || tool?.function?.name || "")) === index),
          ...(optimized.body?.parallel_tool_calls === undefined ? { parallel_tool_calls: true } : {}),
        }
        : {}),
  };
  delete upstreamBody.protocol;
  if (optimized.stats.optimized || optimized.stats.deduplicated) {
    console.info(
      `[OpenCodex Computer Use] optimized third-party Responses screenshots ` +
      `optimized=${optimized.stats.optimized} deduplicated=${optimized.stats.deduplicated} ` +
      `bytes=${optimized.stats.inputBytes}->${optimized.stats.outputBytes}`,
    );
  }

  try {
    const upstreamRes = await fetchUpstream(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
      maxAttempts: 1,
      timeoutMs: 120_000,
      operation: "native-third-party-responses",
    });

    if (!upstreamRes.ok || !upstreamRes.body) {
      const errorText = await upstreamRes.text();
      if (upstreamRes.status === 400) {
        CatalogSyncService.learnReasoningLevelsFromProviderError(providerName, upstreamModel, errorText);
      }
      if (isResponsesUnsupported(upstreamRes.status, errorText)) {
        console.warn(`[OpenCodex Provider] Responses unsupported by ${targetUrl}; falling back to Chat conversion`);
        return "fallback";
      }
      const responseHeaders: Record<string, string> = { "Content-Type": "application/json" };
      res.writeHead(upstreamRes.status, responseHeaders);
      res.end(errorText || JSON.stringify({ error: `Upstream API Error (${upstreamRes.status})` }));
      return "handled";
    }

    let responseForHeaders = upstreamRes;
    let collected: CollectedThirdPartyResponses = await collectThirdPartyResponsesBody(upstreamRes);
    let continuationRound = 0;
    while (subagentDispatcher && !isSubagentRequest && collected.calls.length > 0) {
      continuationRound += 1;
      if (continuationRound > 8) throw new Error("第三方主模型连续调度子代理超过 8 轮，已停止继续递归");
      const results = await subagentDispatcher(collected.calls, subagentContext);
      if (results.length > 0 && results.every((result) => Boolean(result.error))) {
        const details = results.map((result) => result.error).filter(Boolean).join("；");
        throw new Error(`子代理调度失败，已停止主模型重试：${details || "没有可用的子代理结果"}`);
      }
      const continuationBody = buildThirdPartyResponsesSubagentContinuation(upstreamBody, collected.calls, results);
      const continuationResponse = await fetchUpstream(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(continuationBody),
        maxAttempts: 1,
        timeoutMs: 120_000,
        operation: "native-third-party-responses-subagent-continuation",
      });
      if (!continuationResponse.ok || !continuationResponse.body) {
        const errorText = await continuationResponse.text();
        if (continuationResponse.status === 400) {
          CatalogSyncService.learnReasoningLevelsFromProviderError(providerName, upstreamModel, errorText);
        }
        throw new Error(`第三方主模型子代理续答失败（HTTP ${continuationResponse.status}）：${errorText.slice(0, 800)}`);
      }
      responseForHeaders = continuationResponse;
      collected = await collectThirdPartyResponsesBody(continuationResponse);
    }

    const responseHeaders = copySafeResponseHeaders(responseForHeaders.headers);
    res.writeHead(responseForHeaders.status, responseHeaders);
    if (collected.events.length > 0) {
      const blockedReasoningIds = new Set<string>();
      const nativeComputerUseCallIds = new Set<string>();
      for (const event of collected.events) {
        const sanitized = sanitizeThirdPartySseEvent(event, blockedReasoningIds, nativeComputerUseCallIds, responseModel);
        if (sanitized) await writeHttpResponseChunked(res, sanitized);
      }
    } else {
      const blockedReasoningIds = new Set<string>();
      const payload = rewriteThirdPartyResponseModel(sanitizeThirdPartyResponsesPayload(
        collected.json,
        blockedReasoningIds,
        new Set<string>(),
      ), responseModel);
      await writeHttpResponseChunked(res, payload === null ? "{}" : JSON.stringify(payload));
    }
    res.end();
    return "handled";
  } catch (err: any) {
    const details = upstreamErrorDetails(err);
    console.error(`[CodexBridge V2] Native third-party Responses proxy error:`, {
      ...details,
      attempts: err?.attempts,
    });
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: err.message,
      type: "upstream_unreachable",
      retryable: Boolean(err?.retryable),
      cause_code: details.code,
    }));
    return "handled";
  }
}

function providerChunkSignalsCompletion(chunk: any): boolean {
  if (!chunk || typeof chunk !== "object") return false;
  if (chunk.type === "message_stop" || chunk.type === "response.completed" || chunk.type === "response.done") return true;
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  if (choices.some((choice: any) => choice && choice.finish_reason)) return true;
  const candidates = Array.isArray(chunk.candidates)
    ? chunk.candidates
    : Array.isArray(chunk.response?.candidates)
      ? chunk.response.candidates
      : [];
  return candidates.some((candidate: any) => Boolean(candidate?.finishReason || candidate?.finish_reason));
}


export class GatewayRouter {
  private subagentDispatcher: GatewaySubagentDispatcher | null = null;

  public setSubagentDispatcher(dispatcher: GatewaySubagentDispatcher | null): void {
    this.subagentDispatcher = dispatcher;
  }

  /**
   * Use a provider's native Codex compaction endpoint when it actually
   * implements it. The client-facing contract stays identical to native GPT:
   * the gateway only rewrites the backend model name and response model label.
   * A 404/405/unsupported response is returned to the client; there is no
   * gateway-generated summary fallback.
   */
  public async proxyNativeThirdPartyCompaction(
    reqBody: any,
    upstreamModel: string,
    responseModel: string,
    apiKey: string,
    providerUrl: string,
    res: http.ServerResponse,
  ): Promise<"handled" | "unsupported"> {
    // Keep the native compact request shape identical to the native GPT lane.
    // Only the provider backend model name is translated; the provider owns
    // compaction and must return its native compact response.
    const upstreamBody = buildThirdPartyNativeCompactionBody(reqBody, upstreamModel);
    const targetUrl = responsesCompactionEndpointForProvider(providerUrl);

    try {
      const upstreamRes = await fetchUpstream(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(upstreamBody),
        maxAttempts: 1,
        timeoutMs: 120_000,
        operation: "native-third-party-responses-compact",
      });

      if (!upstreamRes.ok || !upstreamRes.body) {
        const errorText = await upstreamRes.text();
        if (isResponsesUnsupported(upstreamRes.status, errorText)) {
          console.info(`[OpenCodex Compaction] Native endpoint unsupported by ${targetUrl}`);
          return "unsupported";
        }
        res.writeHead(upstreamRes.status, { "Content-Type": "application/json" });
        res.end(errorText || JSON.stringify({ error: `Upstream API Error (${upstreamRes.status})` }));
        return "handled";
      }

      const responseHeaders = copySafeResponseHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.status, responseHeaders);
      const contentType = upstreamRes.headers.get("content-type") || "";
      if (contentType.toLowerCase().includes("text/event-stream")) {
        // @ts-ignore Node's fetch body is an async iterable at runtime.
        await pipeFilteredThirdPartyResponses(upstreamRes.body, res, responseModel);
      } else {
        const raw = await upstreamRes.text();
        try {
          const payload = rewriteThirdPartyResponseModel(JSON.parse(raw), responseModel);
          await writeHttpResponseChunked(res, JSON.stringify(payload));
        } catch {
          await writeHttpResponseChunked(res, raw);
        }
      }
      res.end();
      console.info(`[OpenCodex Compaction] Native third-party compaction passthrough provider=${targetUrl}`);
      return "handled";
    } catch (err: any) {
      const details = upstreamErrorDetails(err);
      console.error(`[CodexBridge V2] Native third-party compaction proxy error:`, {
        ...details,
        attempts: err?.attempts,
      });
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: err.message,
          type: "upstream_unreachable",
          retryable: Boolean(err?.retryable),
          cause_code: details.code,
        }));
      }
      return "handled";
    }
  }

  public async handleResponses(
    reqBody: any,
    upstreamModel: string,
    apiKey: string,
    providerUrl: string,
    res: http.ServerResponse,
    providerName = "",
  nativeImageHeaders: Record<string, string> = {},
  responseModel = "",
  isSubagentRequest = false,
): Promise<void> {
    const sessionId = reqBody?.client_metadata?.session_id || reqBody?.session_id;
    const selectedResponseModel = String(responseModel || reqBody?.model || upstreamModel).trim() || upstreamModel;
    const requestUsesComputerUse = hasComputerUseTool(reqBody?.tools);
    if (requestUsesComputerUse) {
      // Native third-party Responses providers do not pass through the Chat
      // transformer, so give both protocol paths the same direct-use rule.
      reqBody = {
        ...reqBody,
        tools: normalizeComputerUseResponsesTools(reqBody.tools),
        instructions: appendComputerUseInstructions(reqBody.instructions, reqBody.tools),
      };
    }
    if (String(reqBody?.protocol || "").toLowerCase() === "responses") {
      // Responses-capable third-party providers receive the request as-is.
      // Computer Use is still a client-owned native tool call; the gateway
      // must never execute desktop actions or synthesize a second bridge.
      const nativeResult = await proxyThirdPartyResponses(
        reqBody,
        upstreamModel,
        selectedResponseModel,
        apiKey,
        providerUrl,
        res,
        isSubagentRequest,
        this.subagentDispatcher,
        {
          parent_task_id: sessionId,
          parent_model: selectedResponseModel,
          backend_model: upstreamModel,
          parent_reasoning_effort: String(reqBody?.reasoning?.effort || reqBody?.reasoning_effort || "").trim() || undefined,
        },
        providerName,
      );
      if (nativeResult === "handled") return;
      // The configured Responses endpoint is unavailable; use the existing
      // Chat compatibility conversion for this request.
      reqBody = { ...reqBody, protocol: "chat" };
    }
    const imageGenerationContext = extractImageGenerationContext(reqBody);
    const chatBody = transformResponsesToChat(reqBody, upstreamModel, sessionId, !isSubagentRequest);
    const optimizedChat = await optimizeThirdPartyComputerUseImages(chatBody);
    const optimizedChatBody = optimizedChat.body;
    const isXiaomiMimoChat = isXiaomiMimoProvider(providerName, providerUrl, upstreamModel);
    // MiMo's Chat validator is stricter than the OpenAI schema for tool
    // history: an assistant tool-call turn and an image-only tool result must
    // still carry a text field. Keep this isolated to the Xiaomi/MiMo route;
    // MiniMax and all other providers retain the ordinary Chat payload.
    const providerChatBody = isXiaomiMimoChat
      ? normalizeXiaomiChatToolHistory(optimizedChatBody)
      : optimizedChatBody;
    providerChatBody.stream = true;
    if (optimizedChat.stats.optimized || optimizedChat.stats.deduplicated) {
      console.info(
        `[OpenCodex Computer Use] optimized third-party Chat screenshots ` +
        `optimized=${optimizedChat.stats.optimized} deduplicated=${optimizedChat.stats.deduplicated} ` +
        `bytes=${optimizedChat.stats.inputBytes}->${optimizedChat.stats.outputBytes}`,
      );
    }
    optimizedChatBody.stream = true;

    const adapter = AdapterFactory.getAdapter(reqBody?.protocol, providerUrl);
    const { urlEndpoint, headers: adapterHeaders, body: payloadBody } = adapter.transformPayload(providerChatBody);

    // Callers may provide either a provider base URL or an already selected
    // OpenAI endpoint. Normalize both forms before an adapter chooses its
    // protocol-specific path; otherwise Anthropic-compatible models can end
    // up at `/chat/completions/v1/messages`.
    const providerBaseUrl = providerUrl.replace(/\/(?:chat\/completions|messages)\/?$/i, "");
    const adapterPath = /\/v1$/i.test(providerBaseUrl) && /^\/v1\//i.test(urlEndpoint)
      ? urlEndpoint.slice("/v1".length)
      : urlEndpoint;
    const targetUrl = adapterPath
      ? `${providerBaseUrl.replace(/\/$/, "")}${adapterPath}`
      : /\/chat\/completions\/?$/i.test(providerUrl)
        ? providerUrl
        : `${providerBaseUrl.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...adapterHeaders,
    };
    // OpenCode Go's Anthropic Messages-compatible models validate the API key
    // through x-api-key. Keep Authorization as well for providers that accept
    // the OpenAI-compatible bearer convention.
    if (adapter.name === "anthropic" && apiKey) {
      headers["x-api-key"] = apiKey;
    }

    const finalTargetUrl = targetUrl;
    const finalHeaders = headers;
    const activeAdapter = adapter;
    let finalPayloadBody = payloadBody;

    // Ask OpenAI-compatible Chat endpoints for their actual stream usage when
    // supported. This is optional metadata; providers that omit it still work
    // and the Responses engine will simply leave usage absent.
    if (activeAdapter.name === "openai" && finalPayloadBody && typeof finalPayloadBody === "object") {
      finalPayloadBody = {
        ...finalPayloadBody,
        stream_options: {
          ...(finalPayloadBody.stream_options || {}),
          include_usage: true,
        },
      };
    }

    console.info(
      `[OpenCodex Provider] request provider=${providerName || "provider"} model=${upstreamModel} ` +
      `messages=${Array.isArray(finalPayloadBody?.messages) ? finalPayloadBody.messages.length : 0} ` +
      `tools=${Array.isArray(finalPayloadBody?.tools) ? finalPayloadBody.tools.map((tool: any) => tool?.function?.name || tool?.name).filter(Boolean).join(",") || "(none)" : "(none)"} ` +
      `tool_images=${hasChatToolImages(finalPayloadBody)} ` +
      `continuation=${Boolean(reqBody?.input?.some?.((item: any) => item?.type === "function_call_output"))}`,
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.socket?.setNoDelay(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600000);

    const writeSse = async (payload: any) => {
      if (!res.writableEnded) {
        await writeSseData(res, payload);
      }
    };

    // Native Computer Use often starts a turn with explanatory text and only
    // emits the node-repl call a few chunks later. Keep that message in the
    // commentary phase from its first event; otherwise Codex Desktop may
    // treat the early text as a replaceable final answer and clear it when
    // the first desktop action arrives.
    const nativeComputerUseTurn = requestUsesComputerUse || hasNativeComputerUseTool(optimizedChatBody?.tools);
    const engine = new ResponsesStreamEngine(
      upstreamModel,
      reqBody?.client_metadata?.turn_id,
      {
        forceCommentary: nativeComputerUseTurn,
        responseModel: selectedResponseModel,
        // A third-party main model must be handled by the gateway itself.
        // Child turns are intentionally excluded so delegation cannot recurse.
        internalToolNames: !isSubagentRequest && this.subagentDispatcher
          ? ["spawn_agent", "multi_agent_v1_spawn_agent"]
          : [],
      },
    );
    let engineStarted = false;
    const emitFailedResponse = async (message: string, code = "provider_request_failed"): Promise<void> => {
      if (!engineStarted) {
        await engine.start(writeSse);
        engineStarted = true;
      }
      const now = Math.floor(Date.now() / 1000);
      const failedResponse = {
        id: engine.getResponseId(),
        object: "response",
        created_at: now,
        completed_at: now,
        status: "failed",
        model: selectedResponseModel,
        output: [],
        error: { code, message },
      };
      await writeSse({ type: "response.failed", response: failedResponse });
      await writeSse({ type: "response.done", response: failedResponse });
    };

    try {
      let response = await fetchUpstream(finalTargetUrl, {
        method: "POST",
        headers: finalHeaders,
        body: JSON.stringify(finalPayloadBody),
        signal: controller.signal,
        // A streaming POST may have been accepted by the provider before
        // its headers arrive. Retrying it can create a second execution of
        // the same Live task, so the caller must decide whether to retry.
        maxAttempts: 1,
        timeoutMs: 120_000,
        operation: `responses:${providerName || "provider"}`,
      });

      // A failing turn is reported to the client as-is. The gateway never
      // routes to another provider as an implicit fallback.
      const firstAuthErrorText: string | undefined = undefined;

      clearTimeout(timeoutId);

      // Some legacy Chat gateways accept ordinary tool text but reject a
      // multimodal tool result with a generic Console Go 400. A screenshot
      // result is optional for Computer Use because the accessibility tree is
      // still present in the text result, so retry this exact case once with
      // the image removed. Native Responses providers never enter this path.
      let preReadErrorText: string | undefined;
      if (!response.ok || !response.body) {
        const initialErrorText = await response.text();
        if (isConsoleGoToolImageRejection(response.status, initialErrorText, finalPayloadBody)) {
          const fallbackPayloadBody = stripChatToolImages(finalPayloadBody);
          console.warn(
            `[OpenCodex Provider] retrying Chat request without tool images provider=${providerName || "provider"} model=${upstreamModel}`,
          );
          const fallbackResponse = await fetchUpstream(finalTargetUrl, {
            method: "POST",
            headers: finalHeaders,
            body: JSON.stringify(fallbackPayloadBody),
            signal: controller.signal,
            maxAttempts: 1,
            timeoutMs: 120_000,
            operation: `responses:${providerName || "provider"}:chat-tool-image-fallback`,
          });
          response = fallbackResponse;
          if (response.ok && response.body) {
            finalPayloadBody = fallbackPayloadBody;
          } else {
            preReadErrorText = await response.text();
          }
        } else if (isXiaomiChatToolTextRejection(response.status, initialErrorText, finalPayloadBody)) {
          // The first MiMo request already has the strict text fields. If its
          // validator still rejects a screenshot-bearing tool result, retry
          // once with the textual accessibility result only. Do not apply this
          // fallback to MiniMax or to an unrelated Xiaomi 400.
          const normalizedPayload = normalizeXiaomiChatToolHistory(finalPayloadBody);
          const fallbackPayloadBody = stripChatToolImages(normalizedPayload);
          console.warn(
            `[OpenCodex Provider] retrying MiMo Chat continuation with text-only tool results provider=${providerName || "provider"} model=${upstreamModel}`,
          );
          const fallbackResponse = await fetchUpstream(finalTargetUrl, {
            method: "POST",
            headers: finalHeaders,
            body: JSON.stringify(fallbackPayloadBody),
            signal: controller.signal,
            maxAttempts: 1,
            timeoutMs: 120_000,
            operation: `responses:${providerName || "provider"}:mimo-chat-tool-fallback`,
          });
          response = fallbackResponse;
          if (response.ok && response.body) {
            finalPayloadBody = fallbackPayloadBody;
          } else {
            preReadErrorText = await response.text();
          }
        } else {
          preReadErrorText = initialErrorText;
        }
      }

      if (!response.ok || !response.body) {
        res.flushHeaders();
        const errText = firstAuthErrorText && (response.status === 401 || response.status === 403)
          ? firstAuthErrorText
          : preReadErrorText ?? await response.text();
        if (response.status === 400) {
          // A provider validation enum is authoritative capability metadata.
          // Record it for the next model-picker refresh, but never silently
          // replace the user's selected effort on this request.
          CatalogSyncService.learnReasoningLevelsFromProviderError(providerName, upstreamModel, errText);
        }
        console.error(`[CodexBridge V2] Upstream error (${response.status}) for ${finalTargetUrl}: ${errText}`);
        let msg = `Upstream API Error (${response.status})`;
        try {
          const parsed = JSON.parse(errText);
          msg = parsed.error?.message || parsed.error || parsed.message || errText || msg;
        } catch {
          msg = errText || msg;
        }



        // Do not turn an upstream/provider failure into a completed assistant
        // message. Codex and GPT-Live interpret response.completed as a
        // successful turn and may announce that a task was dispatched even
        // though no model response or tool call ever arrived.
        await emitFailedResponse(msg);
        res.end();
        return;
      }

      res.flushHeaders();
      await engine.start(writeSse);
      engineStarted = true;

      if (!response.body) throw new Error("上游没有返回响应体");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const readWithTimeout = (timeoutMs = 600000): Promise<ReadableStreamReadResult<Uint8Array>> => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Stream read timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
          reader.read().then((result) => {
            clearTimeout(timer);
            resolve(result);
          }, (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
      };

      let providerStreamCompleted = false;
      let providerDataObserved = false;
      let parentTextLength = 0;

        const processSseLine = async (line: string): Promise<void> => {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return;
          const dataStr = trimmed.slice("data:".length).trim();
          if (!dataStr) return;
          if (dataStr === "[DONE]") {
            providerStreamCompleted = true;
            return;
          }

          providerDataObserved = true;

          let chunk: any;
          try {
            chunk = JSON.parse(dataStr);
          } catch {
            // SSE comments and provider keep-alives are harmless, but a
            // stream without a terminal event is not allowed to become a
            // synthetic response.completed.
            return;
          }
          if (providerChunkSignalsCompletion(chunk)) providerStreamCompleted = true;
          if (activeAdapter.processStreamChunk) {
            engine.observeProviderChunk(chunk);
            const normalizedChunks = activeAdapter.processStreamChunk(chunk);
            for (const nc of normalizedChunks) {
              await engine.processChatChunk(writeSse, nc);
            }
          } else {
            await engine.processChatChunk(writeSse, chunk);
          }
        };

        while (!providerStreamCompleted) {
          const readResult = await readWithTimeout(600000);
          const { done, value } = readResult;
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) {
              const finalLines = buffer.split("\n");
              buffer = "";
              for (const line of finalLines) await processSseLine(line);
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) await processSseLine(line);
        }

        if (!providerStreamCompleted) {
          // Some OpenAI-compatible gateways close a successful stream after
          // the last content/tool delta and omit both `[DONE]` and
          // `finish_reason`. The output already received from the provider is
          // sufficient to close the local Responses turn; do not fabricate a
          // response for an empty stream.
          if (providerDataObserved && engine.hasOutput()) {
            console.warn(
              `[OpenCodex Provider] upstream stream ended after valid output ` +
              `without a terminal event provider=${providerName || "provider"} model=${upstreamModel}`,
            );
            providerStreamCompleted = true;
          } else {
            throw new Error("上游流在完成事件前结束，且没有收到可收尾的模型输出");
          }
        }

      // Third-party main models cannot hand `spawn_agent` back to Codex
      // Desktop: the desktop only knows its native private tool executor.
      // Consume the gateway-owned calls here, run the selected child models,
      // append their outputs to the provider conversation, and let the same
      // parent model continue. This supports multiple independent children in
      // one turn and keeps the custom tool completely out of the client stream.
      const readAdditionalStandardProviderResponse = async (nextResponse: Response): Promise<void> => {
        if (!nextResponse.ok || !nextResponse.body) {
          const errorText = await nextResponse.text();
          throw new Error(`子代理调度后的主模型续答失败（HTTP ${nextResponse.status}）：${errorText.slice(0, 800)}`);
        }

        if (!nextResponse.body) throw new Error("子代理调度后的主模型续答没有返回响应体");
        const nextReader = nextResponse.body.getReader();
        const nextDecoder = new TextDecoder();
        let nextBuffer = "";
        let nextCompleted = false;
        let nextDataObserved = false;
        const nextReadWithTimeout = (): Promise<ReadableStreamReadResult<Uint8Array>> => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("主模型子代理续答流读取超时（600s）")), 600000);
          nextReader.read().then((result) => {
            clearTimeout(timer);
            resolve(result);
          }, (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
        const processContinuationLine = async (line: string): Promise<void> => {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return;
          const dataStr = trimmed.slice("data:".length).trim();
          if (!dataStr) return;
          if (dataStr === "[DONE]") {
            nextCompleted = true;
            return;
          }
          nextDataObserved = true;
          let chunk: any;
          try { chunk = JSON.parse(dataStr); } catch { return; }
          if (providerChunkSignalsCompletion(chunk)) nextCompleted = true;
          if (activeAdapter.processStreamChunk) {
            engine.observeProviderChunk(chunk);
            for (const normalizedChunk of activeAdapter.processStreamChunk(chunk)) {
              await engine.processChatChunk(writeSse, normalizedChunk);
            }
          } else {
            await engine.processChatChunk(writeSse, chunk);
          }
        };

        while (!nextCompleted) {
          const readResult = await nextReadWithTimeout();
          if (readResult.done) {
            nextBuffer += nextDecoder.decode();
            if (nextBuffer.trim()) {
              for (const line of nextBuffer.split("\n")) await processContinuationLine(line);
            }
            nextBuffer = "";
            break;
          }
          nextBuffer += nextDecoder.decode(readResult.value, { stream: true });
          const lines = nextBuffer.split("\n");
          nextBuffer = lines.pop() || "";
          for (const line of lines) await processContinuationLine(line);
        }
        if (!nextCompleted && !nextDataObserved) {
          throw new Error("主模型子代理续答流在完成事件前结束");
        }
      };

      const rebuildProviderPayloadForContinuation = (): void => {
        const continuationChatBody = isXiaomiMimoChat
          ? normalizeXiaomiChatToolHistory(optimizedChatBody)
          : optimizedChatBody;
        const transformed = activeAdapter.transformPayload(continuationChatBody);
        finalPayloadBody = transformed.body;
        if (activeAdapter.name === "openai" && finalPayloadBody && typeof finalPayloadBody === "object") {
          finalPayloadBody = {
            ...finalPayloadBody,
            stream_options: {
              ...(finalPayloadBody.stream_options || {}),
              include_usage: true,
            },
          };
        }
      };

      let subagentRound = 0;
      while (this.subagentDispatcher && !isSubagentRequest) {
        const internalCalls = engine.takeInternalToolCalls();
        if (internalCalls.length === 0) break;
        subagentRound += 1;
        if (subagentRound > 8) throw new Error("主模型连续调度子代理超过 8 轮，已停止继续递归");

        const results = await this.subagentDispatcher(internalCalls, {
          parent_task_id: sessionId,
          parent_model: selectedResponseModel,
          provider: providerName,
          backend_model: upstreamModel,
          parent_reasoning_effort: String(reqBody?.reasoning?.effort || reqBody?.reasoning_effort || "").trim() || undefined,
        });
        if (results.length > 0 && results.every((result) => Boolean(result.error))) {
          const details = results.map((result) => result.error).filter(Boolean).join("；");
          throw new Error(`子代理调度失败，已停止主模型重试：${details || "没有可用的子代理结果"}`);
        }
        const resultByCallId = new Map(results.map((result) => [result.call_id, result]));
        const currentText = engine.getMessageText();
        const assistantText = currentText.slice(parentTextLength);
        parentTextLength = currentText.length;
          optimizedChatBody.messages.push({
          role: "assistant",
          content: assistantText,
          tool_calls: internalCalls.map((call) => ({
            id: call.call_id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
            ...(call.thought_signature ? { thought_signature: call.thought_signature, thoughtSignature: call.thought_signature } : {}),
          })),
        });
        for (const call of internalCalls) {
          const result = resultByCallId.get(call.call_id);
          const output = result?.error
            ? `子代理执行失败：${result.error}`
            : result?.output || "子代理已完成，但没有返回文本。";
          optimizedChatBody.messages.push({
            role: "tool",
            tool_call_id: call.call_id,
            name: call.name,
            content: output,
          });
        }
        rebuildProviderPayloadForContinuation();
        console.info(
          `[OpenCodex Subagent] third-party parent continuation round=${subagentRound} ` +
          `children=${internalCalls.length} ` +
          `models=${results.map((result) => result.model || "unresolved").join(",")}`,
        );
        const continuationResponse = await fetchUpstream(finalTargetUrl, {
          method: "POST",
          headers: finalHeaders,
          body: JSON.stringify(finalPayloadBody),
          signal: controller.signal,
          maxAttempts: 1,
          timeoutMs: 120_000,
          operation: `responses:${providerName || "provider"}:subagent-continuation`,
        });
        await readAdditionalStandardProviderResponse(continuationResponse);
      }

      const internalImageCalls = engine.getInternalImageToolCalls();
      for (const call of internalImageCalls) {
        const imageArgs = parseImageGenerationArguments(call.arguments, imageGenerationContext.text);
        const images = await generateNativeCodexImage(imageArgs, imageGenerationContext, nativeImageHeaders);
        for (const image of images) {
          await engine.emitImageGeneration(writeSse, {
            result: image.data,
            revised_prompt: image.revisedPrompt,
            partial_images: image.partialImages,
          });
        }
      }

      await engine.finish(writeSse);
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } catch (err: any) {
      clearTimeout(timeoutId);
      controller.abort();
      const upstreamDetails = upstreamErrorDetails(err);
      console.error(`[CodexBridge V2] Stream error for ${finalTargetUrl}:`, {
        stack: err.stack,
        ...upstreamDetails,
        attempts: err?.attempts,
      });
      const attemptsText = Number.isFinite(err?.attempts) ? `（已尝试 ${err.attempts} 次）` : "";
      const causeText = upstreamDetails.code ? ` [${upstreamDetails.code}]` : "";
      const detailMsg = err.message === "fetch failed"
        ? `无法连接服务商接口${causeText}${attemptsText}：网络连接或 TLS 握手失败。请在 OpenCodex 控制面板检查该服务商 Endpoint / Base URL 是否填写正确。`
        : err.message;
      if (!res.headersSent) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
      }
      if (!res.writableEnded) {
        // A transport failure is also a failed Responses turn, regardless of
        // whether the provider failed before headers or during its stream.
        // Never synthesize assistant text or response.completed here.
        await emitFailedResponse(detailMsg, "upstream_unreachable");
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  }
}

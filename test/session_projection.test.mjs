import test from "node:test";
import assert from "node:assert/strict";
import { responsesInputToChatMessages } from "../dist/core/transformer.js";

test("session projection preserves visible user and assistant messages", () => {
  const result = responsesInputToChatMessages([
    { type: "message", role: "user", content: "请检查这个页面" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "这是完整的 AI 回复。" }] }
  ]);
  assert.deepEqual(result, [
    { role: "user", content: "请检查这个页面" },
    { role: "assistant", content: "这是完整的 AI 回复。" }
  ]);
});

test("internal Codex envelopes are not projected to third-party providers", () => {
  const result = responsesInputToChatMessages([
    { type: "message", role: "user", content: "<environment_context>private</environment_context>你好" }
  ]);
  assert.equal(result[0].content, "你好");
});


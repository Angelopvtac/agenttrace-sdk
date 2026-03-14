import { describe, it, expect, beforeEach, vi } from "vitest";
import { TraceStore, TraceCollector } from "../src/index.js";
import type { PatchContext } from "../src/instrumentation/types.js";
import { patchAnthropic, type AnthropicPatchTarget } from "../src/instrumentation/anthropic.js";

function createMockAnthropic() {
  const mockResponse = {
    id: "msg_123",
    model: "claude-sonnet-4-6",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello!" }],
    usage: { input_tokens: 12, output_tokens: 8 },
    stop_reason: "end_turn",
  };

  const mockCreate = vi.fn().mockResolvedValue(mockResponse);

  const target: AnthropicPatchTarget = {
    Messages: {
      prototype: {
        create: mockCreate,
      },
    },
  };

  return { target, mockCreate, mockResponse };
}

describe("Anthropic Auto-Instrumentation", () => {
  let store: TraceStore;
  let collector: TraceCollector;
  let activeTraceId: string | null;

  beforeEach(() => {
    store = new TraceStore(":memory:");
    collector = new TraceCollector({ store });
    activeTraceId = null;
  });

  function makeContext(overrides?: Partial<PatchContext>): PatchContext {
    return {
      collector,
      agentId: "test-agent",
      captureContent: false,
      getActiveTrace: () => activeTraceId,
      ...overrides,
    };
  }

  it("records an LLM call span after a successful call", async () => {
    const { target } = createMockAnthropic();
    const ctx = makeContext();
    const patch = patchAnthropic(target, ctx);

    activeTraceId = collector.startTrace();

    await target.Messages.prototype.create.call(
      {},
      { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "Hi" }], max_tokens: 1024 }
    );

    const spans = store.getSpans(activeTraceId);
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("llm.claude-sonnet-4-6");
    expect(spans[0].type).toBe("agent.llm_call");
    expect(spans[0].attributes.prompt_tokens).toBe(12);
    expect(spans[0].attributes.completion_tokens).toBe(8);
    expect(spans[0].status).toBe("ok");

    patch.restore();
  });

  it("records error status when the call throws", async () => {
    const { target } = createMockAnthropic();
    target.Messages.prototype.create = vi.fn().mockRejectedValue(new Error("overloaded"));
    const ctx = makeContext();
    const patch = patchAnthropic(target, ctx);

    activeTraceId = collector.startTrace();

    await expect(
      target.Messages.prototype.create.call(
        {},
        { model: "claude-sonnet-4-6", messages: [], max_tokens: 1024 }
      )
    ).rejects.toThrow("overloaded");

    const spans = store.getSpans(activeTraceId);
    expect(spans).toHaveLength(1);
    expect(spans[0].status).toBe("error");

    patch.restore();
  });

  it("skips recording when no active trace", async () => {
    const { target } = createMockAnthropic();
    const ctx = makeContext();
    const patch = patchAnthropic(target, ctx);

    await target.Messages.prototype.create.call(
      {},
      { model: "claude-sonnet-4-6", messages: [], max_tokens: 1024 }
    );

    const traces = store.listTraces({});
    expect(traces).toHaveLength(0);

    patch.restore();
  });

  it("restores original method on restore()", () => {
    const { target, mockCreate } = createMockAnthropic();
    const ctx = makeContext();
    const patch = patchAnthropic(target, ctx);

    expect(target.Messages.prototype.create).not.toBe(mockCreate);
    patch.restore();
    expect(target.Messages.prototype.create).toBe(mockCreate);
  });

  it("captures content when captureContent is true", async () => {
    const { target } = createMockAnthropic();
    const ctx = makeContext({ captureContent: true });
    const patch = patchAnthropic(target, ctx);

    activeTraceId = collector.startTrace();

    await target.Messages.prototype.create.call(
      {},
      { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "Hello" }], max_tokens: 1024 }
    );

    const spans = store.getSpans(activeTraceId);
    expect(spans[0].attributes.input).toBeDefined();
    expect(spans[0].attributes.output).toBe("Hello!");

    patch.restore();
  });

  it("uses input_tokens and output_tokens from Anthropic response", async () => {
    const { target } = createMockAnthropic();
    const ctx = makeContext();
    const patch = patchAnthropic(target, ctx);

    activeTraceId = collector.startTrace();

    await target.Messages.prototype.create.call(
      {},
      { model: "claude-sonnet-4-6", messages: [], max_tokens: 1024 }
    );

    const spans = store.getSpans(activeTraceId);
    expect(spans[0].attributes.prompt_tokens).toBe(12);
    expect(spans[0].attributes.completion_tokens).toBe(8);

    patch.restore();
  });
});

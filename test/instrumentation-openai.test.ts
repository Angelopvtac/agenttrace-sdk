import { describe, it, expect, beforeEach, vi } from "vitest";
import { TraceStore, TraceCollector } from "../src/index.js";
import type { PatchContext } from "../src/instrumentation/types.js";
import { patchOpenAI, type OpenAIPatchTarget } from "../src/instrumentation/openai.js";

function createMockOpenAI() {
  const mockResponse = {
    id: "chatcmpl-123",
    model: "gpt-4o",
    choices: [{ message: { role: "assistant", content: "Hello!" }, index: 0, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  const mockCreate = vi.fn().mockResolvedValue(mockResponse);

  const target: OpenAIPatchTarget = {
    Chat: {
      Completions: {
        prototype: {
          create: mockCreate,
        },
      },
    },
    Embeddings: {
      prototype: {
        create: vi.fn().mockResolvedValue({
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 8, total_tokens: 8 },
          data: [{ embedding: [0.1, 0.2], index: 0 }],
        }),
      },
    },
  };

  return { target, mockCreate, mockResponse };
}

describe("OpenAI Auto-Instrumentation", () => {
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

  describe("chat.completions.create", () => {
    it("records an LLM call span after a successful call", async () => {
      const { target } = createMockOpenAI();
      const ctx = makeContext();
      const patch = patchOpenAI(target, ctx);

      activeTraceId = collector.startTrace("test-wf");

      await target.Chat.Completions.prototype.create.call(
        {},
        { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }
      );

      const spans = store.getSpans(activeTraceId);
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe("llm.gpt-4o");
      expect(spans[0].type).toBe("agent.llm_call");
      expect(spans[0].attributes.prompt_tokens).toBe(10);
      expect(spans[0].attributes.completion_tokens).toBe(5);
      expect(spans[0].status).toBe("ok");

      patch.restore();
    });

    it("records error status when the call throws", async () => {
      const { target } = createMockOpenAI();
      target.Chat.Completions.prototype.create = vi.fn().mockRejectedValue(new Error("API error"));
      const ctx = makeContext();
      const patch = patchOpenAI(target, ctx);

      activeTraceId = collector.startTrace();

      await expect(
        target.Chat.Completions.prototype.create.call(
          {},
          { model: "gpt-4o", messages: [] }
        )
      ).rejects.toThrow("API error");

      const spans = store.getSpans(activeTraceId);
      expect(spans).toHaveLength(1);
      expect(spans[0].status).toBe("error");

      patch.restore();
    });

    it("skips recording when no active trace and autoTrace is off", async () => {
      const { target } = createMockOpenAI();
      const ctx = makeContext();
      const patch = patchOpenAI(target, ctx);

      await target.Chat.Completions.prototype.create.call(
        {},
        { model: "gpt-4o", messages: [] }
      );

      const traces = store.listTraces({});
      expect(traces).toHaveLength(0);

      patch.restore();
    });

    it("restores original method on restore()", () => {
      const { target, mockCreate } = createMockOpenAI();
      const ctx = makeContext();
      const patch = patchOpenAI(target, ctx);

      expect(target.Chat.Completions.prototype.create).not.toBe(mockCreate);
      patch.restore();
      expect(target.Chat.Completions.prototype.create).toBe(mockCreate);
    });

    it("captures content when captureContent is true", async () => {
      const { target } = createMockOpenAI();
      const ctx = makeContext({ captureContent: true });
      const patch = patchOpenAI(target, ctx);

      activeTraceId = collector.startTrace();

      await target.Chat.Completions.prototype.create.call(
        {},
        { model: "gpt-4o", messages: [{ role: "user", content: "Hello" }] }
      );

      const spans = store.getSpans(activeTraceId);
      expect(spans[0].attributes.input).toBeDefined();
      expect(spans[0].attributes.output).toBeDefined();

      patch.restore();
    });

    it("truncates captured content to 10KB", async () => {
      const longContent = "x".repeat(20_000);
      const { target } = createMockOpenAI();
      target.Chat.Completions.prototype.create = vi.fn().mockResolvedValue({
        model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: longContent } }],
        usage: { prompt_tokens: 100, completion_tokens: 5000, total_tokens: 5100 },
      });
      const ctx = makeContext({ captureContent: true });
      const patch = patchOpenAI(target, ctx);

      activeTraceId = collector.startTrace();

      await target.Chat.Completions.prototype.create.call(
        {},
        { model: "gpt-4o", messages: [{ role: "user", content: longContent }] }
      );

      const spans = store.getSpans(activeTraceId);
      const input = spans[0].attributes.input as string;
      const output = spans[0].attributes.output as string;
      expect(input.length).toBeLessThanOrEqual(10_240);
      expect(output.length).toBeLessThanOrEqual(10_240);

      patch.restore();
    });
  });

  describe("embeddings.create", () => {
    it("records an embedding span", async () => {
      const { target } = createMockOpenAI();
      const ctx = makeContext();
      const patch = patchOpenAI(target, ctx);

      activeTraceId = collector.startTrace();

      await target.Embeddings.prototype.create.call(
        {},
        { model: "text-embedding-3-small", input: "hello" }
      );

      const spans = store.getSpans(activeTraceId);
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe("llm.text-embedding-3-small");
      expect(spans[0].attributes.prompt_tokens).toBe(8);
      expect(spans[0].attributes.completion_tokens).toBe(0);

      patch.restore();
    });
  });
});

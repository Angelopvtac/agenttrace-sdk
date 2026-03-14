import { describe, it, expect, beforeEach, vi } from "vitest";
import { TraceStore, TraceCollector } from "../src/index.js";
import { InstrumentationManager } from "../src/instrumentation/index.js";
import type { OpenAIPatchTarget } from "../src/instrumentation/openai.js";
import type { AnthropicPatchTarget } from "../src/instrumentation/anthropic.js";

function createMockOpenAI(): OpenAIPatchTarget {
  return {
    Chat: {
      Completions: {
        prototype: {
          create: vi.fn().mockResolvedValue({
            model: "gpt-4o",
            choices: [{ message: { role: "assistant", content: "Hi" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        },
      },
    },
    Embeddings: {
      prototype: {
        create: vi.fn().mockResolvedValue({
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 8, total_tokens: 8 },
          data: [],
        }),
      },
    },
  };
}

function createMockAnthropic(): AnthropicPatchTarget {
  return {
    Messages: {
      prototype: {
        create: vi.fn().mockResolvedValue({
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Hello" }],
          usage: { input_tokens: 12, output_tokens: 8 },
        }),
      },
    },
  };
}

describe("InstrumentationManager", () => {
  let store: TraceStore;
  let collector: TraceCollector;

  beforeEach(() => {
    store = new TraceStore(":memory:");
    collector = new TraceCollector({ store });
  });

  it("patches OpenAI and Anthropic targets", () => {
    const openai = createMockOpenAI();
    const anthropic = createMockAnthropic();

    const manager = new InstrumentationManager({
      collector,
      frameworks: ["openai", "anthropic"],
      agentId: "agent-1",
      targets: { openai, anthropic },
    });

    expect(manager.patchedFrameworks).toEqual(["openai", "anthropic"]);
    manager.restore();
  });

  it("skips frameworks without targets when SDK is not installed", () => {
    const manager = new InstrumentationManager({
      collector,
      frameworks: ["openai", "anthropic"],
      targets: {},
    });

    // Neither SDK is installed, so no patches applied
    expect(manager.patchedFrameworks).toEqual([]);
    manager.restore();
  });

  it("setActiveTrace and getActiveTrace work", () => {
    const manager = new InstrumentationManager({
      collector,
      frameworks: [],
      targets: {},
    });

    expect(manager.getActiveTrace()).toBeNull();
    manager.setActiveTrace("trace-123");
    expect(manager.getActiveTrace()).toBe("trace-123");
    manager.clearActiveTrace();
    expect(manager.getActiveTrace()).toBeNull();
  });

  it("records spans through patched OpenAI target", async () => {
    const openai = createMockOpenAI();
    const manager = new InstrumentationManager({
      collector,
      frameworks: ["openai"],
      targets: { openai },
      agentId: "my-agent",
    });

    const traceId = collector.startTrace();
    manager.setActiveTrace(traceId);

    await openai.Chat.Completions.prototype.create.call(
      {},
      { model: "gpt-4o", messages: [] }
    );

    const spans = store.getSpans(traceId);
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes.agent_id).toBe("my-agent");

    manager.restore();
  });

  it("records spans through patched Anthropic target", async () => {
    const anthropic = createMockAnthropic();
    const manager = new InstrumentationManager({
      collector,
      frameworks: ["anthropic"],
      targets: { anthropic },
      agentId: "my-agent",
    });

    const traceId = collector.startTrace();
    manager.setActiveTrace(traceId);

    await anthropic.Messages.prototype.create.call(
      {},
      { model: "claude-sonnet-4-6", messages: [], max_tokens: 1024 }
    );

    const spans = store.getSpans(traceId);
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("llm.claude-sonnet-4-6");

    manager.restore();
  });

  it("restore() unpatches all frameworks", () => {
    const openai = createMockOpenAI();
    const anthropic = createMockAnthropic();
    const origOpenAI = openai.Chat.Completions.prototype.create;
    const origAnthropic = anthropic.Messages.prototype.create;

    const manager = new InstrumentationManager({
      collector,
      frameworks: ["openai", "anthropic"],
      targets: { openai, anthropic },
    });

    expect(openai.Chat.Completions.prototype.create).not.toBe(origOpenAI);
    expect(anthropic.Messages.prototype.create).not.toBe(origAnthropic);

    manager.restore();

    expect(openai.Chat.Completions.prototype.create).toBe(origOpenAI);
    expect(anthropic.Messages.prototype.create).toBe(origAnthropic);
  });

  describe("autoTrace mode", () => {
    it("auto-creates a trace when no active trace exists", async () => {
      const openai = createMockOpenAI();
      const manager = new InstrumentationManager({
        collector,
        frameworks: ["openai"],
        targets: { openai },
        autoTrace: true,
        agentId: "auto-agent",
      });

      await openai.Chat.Completions.prototype.create.call(
        {},
        { model: "gpt-4o", messages: [] }
      );

      const traceId = manager.getActiveTrace();
      expect(traceId).not.toBeNull();

      const spans = store.getSpans(traceId!);
      expect(spans).toHaveLength(1);

      manager.restore();
    });

    it("reuses existing auto-created trace for subsequent calls", async () => {
      const openai = createMockOpenAI();
      const manager = new InstrumentationManager({
        collector,
        frameworks: ["openai"],
        targets: { openai },
        autoTrace: true,
      });

      await openai.Chat.Completions.prototype.create.call(
        {},
        { model: "gpt-4o", messages: [] }
      );
      const firstTraceId = manager.getActiveTrace();

      await openai.Chat.Completions.prototype.create.call(
        {},
        { model: "gpt-4o", messages: [] }
      );
      const secondTraceId = manager.getActiveTrace();

      expect(firstTraceId).toBe(secondTraceId);

      const spans = store.getSpans(firstTraceId!);
      expect(spans).toHaveLength(2);

      manager.restore();
    });

    it("auto-ends trace after idle timeout", async () => {
      vi.useFakeTimers();

      const openai = createMockOpenAI();
      const manager = new InstrumentationManager({
        collector,
        frameworks: ["openai"],
        targets: { openai },
        autoTrace: true,
        autoTraceIdleMs: 100,
      });

      await openai.Chat.Completions.prototype.create.call(
        {},
        { model: "gpt-4o", messages: [] }
      );

      const traceId = manager.getActiveTrace();
      expect(traceId).not.toBeNull();

      vi.advanceTimersByTime(150);

      expect(manager.getActiveTrace()).toBeNull();
      const trace = store.getTrace(traceId!);
      expect(trace).not.toBeNull();

      manager.restore();
      vi.useRealTimers();
    });
  });
});

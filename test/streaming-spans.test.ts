import { describe, it, expect, beforeEach, vi } from "vitest";
import { TraceStore, TraceCollector } from "../src/index.js";
import type { Span, Trace } from "../src/index.js";

describe("TraceCollector — streaming spans (EventEmitter)", () => {
  let store: TraceStore;
  let collector: TraceCollector;

  beforeEach(() => {
    store = new TraceStore(":memory:");
    collector = new TraceCollector({ store });
  });

  // -----------------------------------------------------------------------
  // "span" event fires for each record method
  // -----------------------------------------------------------------------

  it('"span" event fires after recordLlmCall', () => {
    const handler = vi.fn();
    collector.on("span", handler);
    const traceId = collector.startTrace();
    collector.recordLlmCall(traceId, {
      model: "claude-sonnet-4-6",
      prompt_tokens: 100,
      completion_tokens: 50,
      duration_ms: 500,
      agent_id: "a",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    const emittedSpan: Span = handler.mock.calls[0][0];
    expect(emittedSpan.type).toBe("agent.llm_call");
    expect(emittedSpan.trace_id).toBe(traceId);
  });

  it('"span" event fires after recordToolCall', () => {
    const handler = vi.fn();
    collector.on("span", handler);
    const traceId = collector.startTrace();
    collector.recordToolCall(traceId, {
      tool_name: "bash",
      success: true,
      duration_ms: 100,
      agent_id: "a",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    const emittedSpan: Span = handler.mock.calls[0][0];
    expect(emittedSpan.type).toBe("agent.tool_call");
  });

  it('"span" event fires after recordMessage', () => {
    const handler = vi.fn();
    collector.on("span", handler);
    const traceId = collector.startTrace();
    collector.recordMessage(traceId, {
      from_agent: "planner",
      to_agent: "executor",
      content_summary: "go",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    const emittedSpan: Span = handler.mock.calls[0][0];
    expect(emittedSpan.type).toBe("agent.message");
  });

  it('"span" event fires after recordDecision', () => {
    const handler = vi.fn();
    collector.on("span", handler);
    const traceId = collector.startTrace();
    collector.recordDecision(traceId, {
      decision_point: "route",
      options_considered: ["A", "B"],
      choice_made: "A",
      confidence: 0.9,
      agent_id: "a",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    const emittedSpan: Span = handler.mock.calls[0][0];
    expect(emittedSpan.type).toBe("agent.decision");
  });

  // -----------------------------------------------------------------------
  // "trace:start" and "trace:end" events
  // -----------------------------------------------------------------------

  it('"trace:start" event fires with traceId on startTrace()', () => {
    const handler = vi.fn();
    collector.on("trace:start", handler);
    const traceId = collector.startTrace("wf-001");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(traceId);
  });

  it('"trace:end" event fires with finalized Trace on endTrace()', () => {
    const handler = vi.fn();
    collector.on("trace:end", handler);
    const traceId = collector.startTrace("wf-002");
    collector.recordLlmCall(traceId, {
      model: "claude-sonnet-4-6",
      prompt_tokens: 100,
      completion_tokens: 50,
      duration_ms: 300,
      agent_id: "a",
    });
    collector.endTrace(traceId);
    expect(handler).toHaveBeenCalledTimes(1);
    const emittedTrace: Trace = handler.mock.calls[0][0];
    expect(emittedTrace.trace_id).toBe(traceId);
    expect(emittedTrace.span_count).toBe(1);
  });

  // -----------------------------------------------------------------------
  // off() unsubscribes a handler
  // -----------------------------------------------------------------------

  it("off() successfully unsubscribes a handler", () => {
    const handler = vi.fn();
    collector.on("span", handler);
    const traceId = collector.startTrace();
    collector.recordToolCall(traceId, {
      tool_name: "bash",
      success: true,
      duration_ms: 50,
      agent_id: "a",
    });
    expect(handler).toHaveBeenCalledTimes(1);

    collector.off("span", handler);
    collector.recordToolCall(traceId, {
      tool_name: "bash",
      success: true,
      duration_ms: 50,
      agent_id: "a",
    });
    // Still only 1 call — handler was removed before the second recordToolCall
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Multiple listeners receive the same event
  // -----------------------------------------------------------------------

  it("multiple listeners receive the same span event", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    collector.on("span", handler1);
    collector.on("span", handler2);
    const traceId = collector.startTrace();
    collector.recordToolCall(traceId, {
      tool_name: "read_file",
      success: true,
      duration_ms: 20,
      agent_id: "a",
    });
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
    // Both receive the identical span object
    expect(handler1.mock.calls[0][0]).toEqual(handler2.mock.calls[0][0]);
  });

  // -----------------------------------------------------------------------
  // Event fires AFTER persistence
  // -----------------------------------------------------------------------

  it("span event fires AFTER span is persisted — span exists in store when handler runs", () => {
    let spanFoundInStore = false;
    collector.on("span", (span: Span) => {
      const spans = store.getSpans(span.trace_id);
      spanFoundInStore = spans.some((s) => s.span_id === span.span_id);
    });
    const traceId = collector.startTrace();
    collector.recordMessage(traceId, {
      from_agent: "a",
      to_agent: "b",
      content_summary: "hello",
    });
    expect(spanFoundInStore).toBe(true);
  });

  it("trace:start event fires AFTER trace is persisted — trace exists in store when handler runs", () => {
    let traceFoundInStore = false;
    collector.on("trace:start", (traceId: string) => {
      traceFoundInStore = store.getTrace(traceId) !== null;
    });
    collector.startTrace("wf-check");
    expect(traceFoundInStore).toBe(true);
  });

  it("trace:end event fires AFTER finalized trace is persisted", () => {
    let storedSpanCount = -1;
    collector.on("trace:end", (trace: Trace) => {
      const stored = store.getTrace(trace.trace_id);
      storedSpanCount = stored?.span_count ?? -1;
    });
    const traceId = collector.startTrace();
    collector.recordToolCall(traceId, {
      tool_name: "bash",
      success: true,
      duration_ms: 10,
      agent_id: "a",
    });
    collector.endTrace(traceId);
    expect(storedSpanCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // No events fire if no listeners registered — no errors thrown
  // -----------------------------------------------------------------------

  it("no errors thrown when no listeners are registered", () => {
    expect(() => {
      const traceId = collector.startTrace("wf-silent");
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 200,
        agent_id: "a",
      });
      collector.endTrace(traceId);
    }).not.toThrow();
  });
});

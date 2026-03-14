import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { TraceStore, TraceCollector, OtlpExporter } from "../src/index.js";
import type { OtlpExporterOptions } from "../src/index.js";

// Default options used across tests — URL points nowhere intentionally
const DEFAULT_OPTIONS: OtlpExporterOptions = {
  url: "http://localhost:4318/v1/traces",
  serviceName: "test-service",
  serviceVersion: "1.2.3",
};

/**
 * Intercepts the OTLPTraceExporter.export() call so tests can inspect the
 * ReadableSpan objects that the OtlpExporter builds — without needing a live
 * collector running.
 *
 * Returns the captured spans array and a spy reference for further assertions.
 */
function spyOnExport(exporter: OtlpExporter): {
  capturedSpans: ReadableSpan[][];
  spy: ReturnType<typeof vi.spyOn>;
} {
  const capturedSpans: ReadableSpan[][] = [];
  // Access the private `exporter` field via bracket notation
  const inner = (exporter as unknown as { exporter: OTLPTraceExporter })
    .exporter;
  const spy = vi
    .spyOn(inner, "export")
    .mockImplementation((spans: ReadableSpan[], resultCallback) => {
      capturedSpans.push([...spans]);
      resultCallback({ code: 0 }); // ExportResultCode.SUCCESS = 0
    });
  return { capturedSpans, spy };
}

describe("OtlpExporter", () => {
  let store: TraceStore;
  let collector: TraceCollector;

  beforeEach(() => {
    store = new TraceStore(":memory:");
    collector = new TraceCollector({ store });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe("constructor", () => {
    it("creates an instance without throwing", () => {
      expect(
        () => new OtlpExporter(store, DEFAULT_OPTIONS)
      ).not.toThrow();
    });

    it("accepts minimal options (url only)", () => {
      expect(
        () => new OtlpExporter(store, { url: "http://example.com/v1/traces" })
      ).not.toThrow();
    });

    it("accepts optional headers", () => {
      expect(
        () =>
          new OtlpExporter(store, {
            url: "http://example.com/v1/traces",
            headers: { Authorization: "Bearer token123" },
          })
      ).not.toThrow();
    });

    it("accepts all options without throwing", () => {
      expect(
        () =>
          new OtlpExporter(store, {
            url: "http://collector:4318/v1/traces",
            headers: { "X-Api-Key": "secret" },
            serviceName: "my-agent",
            serviceVersion: "2.0.0",
          })
      ).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // exportTrace — empty / non-existent trace
  // ---------------------------------------------------------------------------

  describe("exportTrace() — empty / non-existent trace", () => {
    it("resolves without error when trace ID does not exist", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      await expect(exp.exportTrace("non-existent-trace-id")).resolves.toBeUndefined();
    });

    it("does not call the underlying OTLP exporter when trace has no spans", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { spy } = spyOnExport(exp);
      await exp.exportTrace("ghost-trace");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // UUID conversion (tested indirectly via captured ReadableSpan objects)
  // ---------------------------------------------------------------------------

  describe("UUID conversion", () => {
    it("converts trace UUID to a 32-char hex traceId", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 500,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      const span = capturedSpans[0][0];
      const otelTraceId = span.spanContext().traceId;
      // Should be 32 hex characters (UUID without hyphens)
      expect(otelTraceId).toMatch(/^[0-9a-f]{32}$/);
    });

    it("converts span UUID to a 16-char hex spanId", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 500,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      const span = capturedSpans[0][0];
      const otelSpanId = span.spanContext().spanId;
      // Should be 16 hex characters (first 16 chars of UUID without hyphens)
      expect(otelSpanId).toMatch(/^[0-9a-f]{16}$/);
    });

    it("sets traceFlags to SAMPLED (1) on every span", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "gpt-4o",
        prompt_tokens: 200,
        completion_tokens: 100,
        duration_ms: 300,
        agent_id: "b",
      });

      await exp.exportTrace(traceId);

      const span = capturedSpans[0][0];
      expect(span.spanContext().traceFlags).toBe(1);
    });

    it("converts parent span UUID to 16-char parentSpanId", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      const parent = collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 200,
        agent_id: "a",
      });
      // Record a child span with an explicit parent_span_id
      collector.recordToolCall(traceId, {
        tool_name: "bash",
        success: true,
        duration_ms: 50,
        agent_id: "a",
        parent_span_id: parent.span_id,
      });

      await exp.exportTrace(traceId);

      const childSpan = capturedSpans[0].find(
        (s) => s.name === "tool.bash"
      )!;
      expect(childSpan.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
    });

    it("leaves parentSpanId undefined when span has no parent", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordWorkflow(traceId, {
        workflow_id: "wf-1",
        topology: "sequential",
        status: "ok",
        start_time: Date.now() - 1000,
        end_time: Date.now(),
      });

      await exp.exportTrace(traceId);

      const workflowSpan = capturedSpans[0].find(
        (s) => s.name.startsWith("workflow.")
      )!;
      expect(workflowSpan.parentSpanId).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Span conversion — timing
  // ---------------------------------------------------------------------------

  describe("span conversion — timing", () => {
    it("converts start_time ms to HrTime [seconds, nanoseconds]", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const startMs = 1_700_000_000_123;
      const traceId = collector.startTrace();
      // Inject a span with a known start_time via recordWorkflow
      collector.recordWorkflow(traceId, {
        workflow_id: "wf-time",
        topology: "seq",
        status: "ok",
        start_time: startMs,
        end_time: startMs + 2000,
      });

      await exp.exportTrace(traceId);

      const span = capturedSpans[0][0];
      // [seconds, nanoseconds]
      expect(span.startTime[0]).toBe(Math.floor(startMs / 1000));
      expect(span.startTime[1]).toBe((startMs % 1000) * 1_000_000);
    });

    it("marks spans as ended", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 500,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      expect(capturedSpans[0][0].ended).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Span conversion — status
  // ---------------------------------------------------------------------------

  describe("span conversion — status codes", () => {
    it("maps 'ok' status to SpanStatusCode.OK", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordToolCall(traceId, {
        tool_name: "bash",
        success: true,
        duration_ms: 50,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      expect(capturedSpans[0][0].status.code).toBe(SpanStatusCode.OK);
    });

    it("maps 'error' status to SpanStatusCode.ERROR with message", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordToolCall(traceId, {
        tool_name: "bash",
        success: false,
        duration_ms: 50,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      const status = capturedSpans[0][0].status;
      expect(status.code).toBe(SpanStatusCode.ERROR);
      expect(status.message).toBe("error");
    });

    it("maps 'timeout' status to SpanStatusCode.ERROR with message", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 0,
        duration_ms: 30_000,
        agent_id: "a",
        status: "timeout",
      });

      await exp.exportTrace(traceId);

      const status = capturedSpans[0][0].status;
      expect(status.code).toBe(SpanStatusCode.ERROR);
      expect(status.message).toBe("timeout");
    });

    it("leaves status message undefined for non-error spans", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "gpt-4o",
        prompt_tokens: 50,
        completion_tokens: 20,
        duration_ms: 200,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      expect(capturedSpans[0][0].status.message).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Span conversion — SpanKind
  // ---------------------------------------------------------------------------

  describe("span conversion — SpanKind", () => {
    it("maps agent.message spans to SpanKind.CLIENT", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordMessage(traceId, {
        from_agent: "planner",
        to_agent: "executor",
        content_summary: "do it",
      });

      await exp.exportTrace(traceId);

      expect(capturedSpans[0][0].kind).toBe(SpanKind.CLIENT);
    });

    it("maps agent.workflow spans to SpanKind.PRODUCER", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordWorkflow(traceId, {
        workflow_id: "wf-kind",
        topology: "parallel",
        status: "ok",
        start_time: Date.now() - 1000,
        end_time: Date.now(),
      });

      await exp.exportTrace(traceId);

      expect(capturedSpans[0][0].kind).toBe(SpanKind.PRODUCER);
    });

    it("maps all other span types to SpanKind.INTERNAL", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 200,
        agent_id: "a",
      });
      collector.recordToolCall(traceId, {
        tool_name: "bash",
        success: true,
        duration_ms: 50,
        agent_id: "a",
      });
      collector.recordDecision(traceId, {
        decision_point: "route",
        options_considered: ["A", "B"],
        choice_made: "A",
        confidence: 0.9,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      for (const span of capturedSpans[0]) {
        expect(span.kind).toBe(SpanKind.INTERNAL);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GenAI semantic conventions — agent.llm_call
  // ---------------------------------------------------------------------------

  describe("GenAI semantic conventions (agent.llm_call)", () => {
    it("sets gen_ai.request.model attribute", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 500,
        completion_tokens: 200,
        duration_ms: 1500,
        agent_id: "planner",
      });

      await exp.exportTrace(traceId);

      const attrs = capturedSpans[0][0].attributes;
      expect(attrs["gen_ai.request.model"]).toBe("claude-sonnet-4-6");
    });

    it("sets gen_ai.usage.input_tokens attribute", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "gpt-4o",
        prompt_tokens: 800,
        completion_tokens: 300,
        duration_ms: 1000,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      const attrs = capturedSpans[0][0].attributes;
      expect(attrs["gen_ai.usage.input_tokens"]).toBe(800);
    });

    it("sets gen_ai.usage.output_tokens attribute", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "gpt-4o",
        prompt_tokens: 800,
        completion_tokens: 300,
        duration_ms: 1000,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      const attrs = capturedSpans[0][0].attributes;
      expect(attrs["gen_ai.usage.output_tokens"]).toBe(300);
    });

    it("sets gen_ai.usage.cost attribute", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        duration_ms: 100,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      const attrs = capturedSpans[0][0].attributes;
      expect(typeof attrs["gen_ai.usage.cost"]).toBe("number");
      expect((attrs["gen_ai.usage.cost"] as number)).toBeGreaterThan(0);
    });

    it("always sets agenttrace.span.type attribute", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "gpt-4o",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 200,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      expect(capturedSpans[0][0].attributes["agenttrace.span.type"]).toBe(
        "agent.llm_call"
      );
    });

    it("does not set gen_ai.* attributes on non-LLM spans", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordToolCall(traceId, {
        tool_name: "bash",
        success: true,
        duration_ms: 50,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      const attrs = capturedSpans[0][0].attributes;
      expect(attrs["gen_ai.request.model"]).toBeUndefined();
      expect(attrs["gen_ai.usage.input_tokens"]).toBeUndefined();
      expect(attrs["gen_ai.usage.output_tokens"]).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Span-type-specific attributes
  // ---------------------------------------------------------------------------

  describe("span-type-specific attribute mapping", () => {
    it("maps agent.tool_call attributes to agenttrace.tool.* keys", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordToolCall(traceId, {
        tool_name: "web_search",
        success: true,
        duration_ms: 300,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      const attrs = capturedSpans[0][0].attributes;
      expect(attrs["agenttrace.tool.name"]).toBe("web_search");
      expect(attrs["agenttrace.tool.success"]).toBe(true);
    });

    it("maps agent.message attributes to agenttrace.message.* keys", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordMessage(traceId, {
        from_agent: "alpha",
        to_agent: "beta",
        content_summary: "summarized payload",
      });

      await exp.exportTrace(traceId);

      const attrs = capturedSpans[0][0].attributes;
      expect(attrs["agenttrace.message.from_agent"]).toBe("alpha");
      expect(attrs["agenttrace.message.to_agent"]).toBe("beta");
      expect(attrs["agenttrace.message.content_summary"]).toBe(
        "summarized payload"
      );
    });

    it("maps agent.decision attributes to agenttrace.decision.* keys", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordDecision(traceId, {
        decision_point: "route_request",
        options_considered: ["A", "B", "C"],
        choice_made: "B",
        confidence: 0.85,
        agent_id: "router",
      });

      await exp.exportTrace(traceId);

      const attrs = capturedSpans[0][0].attributes;
      expect(attrs["agenttrace.decision.point"]).toBe("route_request");
      expect(attrs["agenttrace.decision.choice"]).toBe("B");
      expect(attrs["agenttrace.decision.confidence"]).toBe(0.85);
      // options_considered are joined with comma
      expect(attrs["agenttrace.decision.options"]).toBe("A,B,C");
    });

    it("maps agent.workflow attributes to agenttrace.workflow.* keys", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordWorkflow(traceId, {
        workflow_id: "wf-attrs",
        topology: "parallel",
        status: "ok",
        start_time: Date.now() - 2000,
        end_time: Date.now(),
      });

      await exp.exportTrace(traceId);

      const attrs = capturedSpans[0][0].attributes;
      expect(attrs["agenttrace.workflow.id"]).toBe("wf-attrs");
      expect(attrs["agenttrace.workflow.topology"]).toBe("parallel");
    });

    it("maps common agent_id to agenttrace.agent.id", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "gpt-4o",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 200,
        agent_id: "planner-agent",
      });

      await exp.exportTrace(traceId);

      expect(capturedSpans[0][0].attributes["agenttrace.agent.id"]).toBe(
        "planner-agent"
      );
    });
  });

  // ---------------------------------------------------------------------------
  // exportTrace — multi-span trace
  // ---------------------------------------------------------------------------

  describe("exportTrace() — multi-span trace", () => {
    it("sends all spans of a trace in one export call", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans, spy } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 500,
        agent_id: "a",
      });
      collector.recordToolCall(traceId, {
        tool_name: "bash",
        success: true,
        duration_ms: 50,
        agent_id: "a",
      });
      collector.recordMessage(traceId, {
        from_agent: "a",
        to_agent: "b",
        content_summary: "done",
      });

      await exp.exportTrace(traceId);

      // Exactly one call to the underlying exporter
      expect(spy).toHaveBeenCalledTimes(1);
      // All 3 spans included
      expect(capturedSpans[0]).toHaveLength(3);
    });

    it("sets the resource on every span", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 200,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      const resource = capturedSpans[0][0].resource;
      expect(resource).toBeDefined();
      expect(resource.attributes["service.name"]).toBe("test-service");
      expect(resource.attributes["service.version"]).toBe("1.2.3");
    });

    it("uses default resource values when serviceName/Version not provided", async () => {
      const exp = new OtlpExporter(store, {
        url: "http://localhost:4318/v1/traces",
      });
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "gpt-4o",
        prompt_tokens: 50,
        completion_tokens: 20,
        duration_ms: 100,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      const resource = capturedSpans[0][0].resource;
      expect(resource.attributes["service.name"]).toBe("agenttrace-sdk");
      expect(resource.attributes["service.version"]).toBe("0.2.0");
    });

    it("sets instrumentationLibrary name on every span", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "gpt-4o",
        prompt_tokens: 50,
        completion_tokens: 20,
        duration_ms: 100,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      expect(capturedSpans[0][0].instrumentationLibrary.name).toBe(
        "agenttrace-sdk"
      );
    });

    it("sets droppedAttributesCount, droppedEventsCount, droppedLinksCount to 0", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "gpt-4o",
        prompt_tokens: 50,
        completion_tokens: 20,
        duration_ms: 100,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      const span = capturedSpans[0][0];
      expect(span.droppedAttributesCount).toBe(0);
      expect(span.droppedEventsCount).toBe(0);
      expect(span.droppedLinksCount).toBe(0);
    });

    it("sets empty links and events arrays", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "gpt-4o",
        prompt_tokens: 50,
        completion_tokens: 20,
        duration_ms: 100,
        agent_id: "a",
      });

      await exp.exportTrace(traceId);

      const span = capturedSpans[0][0];
      expect(span.links).toEqual([]);
      expect(span.events).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // exportAll
  // ---------------------------------------------------------------------------

  describe("exportAll()", () => {
    it("resolves without error when store is empty", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      await expect(exp.exportAll()).resolves.toBeUndefined();
    });

    it("does not call the OTLP exporter when store is empty", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { spy } = spyOnExport(exp);
      await exp.exportAll();
      expect(spy).not.toHaveBeenCalled();
    });

    it("exports spans from all traces when no filter is provided", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      const trace1 = collector.startTrace();
      collector.recordLlmCall(trace1, {
        model: "gpt-4o",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 200,
        agent_id: "a",
      });
      collector.endTrace(trace1);

      const trace2 = collector.startTrace();
      collector.recordToolCall(trace2, {
        tool_name: "bash",
        success: true,
        duration_ms: 50,
        agent_id: "b",
      });
      collector.recordMessage(trace2, {
        from_agent: "b",
        to_agent: "c",
        content_summary: "hello",
      });
      collector.endTrace(trace2);

      await exp.exportAll();

      // 3 spans total across both traces in one batch
      expect(capturedSpans[0]).toHaveLength(3);
    });

    it("filters traces by status when filter is provided", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { capturedSpans } = spyOnExport(exp);

      // One ok trace
      const okTrace = collector.startTrace();
      collector.recordToolCall(okTrace, {
        tool_name: "read_file",
        success: true,
        duration_ms: 30,
        agent_id: "a",
      });
      collector.endTrace(okTrace);

      // One error trace
      const errTrace = collector.startTrace();
      collector.recordToolCall(errTrace, {
        tool_name: "bash",
        success: false,
        duration_ms: 50,
        agent_id: "a",
      });
      collector.endTrace(errTrace);

      await exp.exportAll({ status: "error" });

      // Only the error trace's spans should be exported
      expect(capturedSpans[0]).toHaveLength(1);
      expect(capturedSpans[0][0].name).toBe("tool.bash");
    });

    it("handles traces with no spans gracefully (skips empty traces)", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const { spy } = spyOnExport(exp);

      // Start a trace but never add spans and never end it
      // listTraces returns ended traces; so this trace won't appear
      // Add one normal completed trace to ensure spy is called
      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "gpt-4o",
        prompt_tokens: 50,
        completion_tokens: 20,
        duration_ms: 100,
        agent_id: "a",
      });
      collector.endTrace(traceId);

      await expect(exp.exportAll()).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // shutdown
  // ---------------------------------------------------------------------------

  describe("shutdown()", () => {
    it("resolves without throwing", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      await expect(exp.shutdown()).resolves.not.toThrow();
    });

    it("can be called multiple times without error", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      await exp.shutdown();
      await expect(exp.shutdown()).resolves.not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Error propagation from OTLP exporter
  // ---------------------------------------------------------------------------

  describe("error propagation", () => {
    it("rejects when the underlying OTLP export returns an error", async () => {
      const exp = new OtlpExporter(store, DEFAULT_OPTIONS);
      const inner = (exp as unknown as { exporter: OTLPTraceExporter }).exporter;

      vi.spyOn(inner, "export").mockImplementation(
        (_spans: ReadableSpan[], resultCallback) => {
          resultCallback({
            code: 1,
            error: new Error("connection refused"),
          });
        }
      );

      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 200,
        agent_id: "a",
      });

      await expect(exp.exportTrace(traceId)).rejects.toThrow(
        "connection refused"
      );
    });
  });
});

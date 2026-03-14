/**
 * OtlpExporter — exports AgentTrace spans to any OpenTelemetry Collector
 * endpoint via OTLP/HTTP.
 *
 * Uses ReadableSpan objects to bridge AgentTrace's stored span data to the
 * OTel SDK export pipeline without requiring a live Tracer context.
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  SpanKind,
  SpanStatusCode,
  type SpanContext,
  type HrTime,
  type Link,
  type SpanAttributes as OtelSpanAttributes,
} from "@opentelemetry/api";
import type { ReadableSpan, TimedEvent } from "@opentelemetry/sdk-trace-base";
import type { InstrumentationLibrary } from "@opentelemetry/core";

import type { Span, TraceFilter } from "../types.js";
import { TraceStore } from "../query/trace-store.js";

export interface OtlpExporterOptions {
  /** OTLP/HTTP endpoint URL, e.g. "http://localhost:4318/v1/traces" */
  url: string;
  /** Optional HTTP headers to include with every export request */
  headers?: Record<string, string>;
  /** Service name reported in the OTel Resource (default: "agenttrace-sdk") */
  serviceName?: string;
  /** Service version reported in the OTel Resource (default: "0.1.0") */
  serviceVersion?: string;
}

/** Maps AgentTrace span status to OTel SpanStatusCode. */
function toOtelStatusCode(status: Span["status"]): SpanStatusCode {
  switch (status) {
    case "ok":
      return SpanStatusCode.OK;
    case "error":
    case "timeout":
      return SpanStatusCode.ERROR;
    default:
      return SpanStatusCode.UNSET;
  }
}

/**
 * Converts a UUID string to a 32-char hex string suitable for OTel traceId.
 * UUIDs are already hex + hyphens; stripping hyphens gives 32 hex chars.
 */
function uuidToTraceId(uuid: string): string {
  return uuid.replace(/-/g, "");
}

/**
 * Converts a UUID string to a 16-char hex string suitable for OTel spanId.
 * Takes the first 16 hex characters of the UUID (after stripping hyphens).
 */
function uuidToSpanId(uuid: string): string {
  return uuid.replace(/-/g, "").slice(0, 16);
}

/** Converts a Unix millisecond timestamp to an OTel HrTime [seconds, nanoseconds]. */
function msToHrTime(ms: number): HrTime {
  const seconds = Math.floor(ms / 1000);
  const nanoseconds = (ms % 1000) * 1_000_000;
  return [seconds, nanoseconds];
}

/**
 * Maps AgentTrace span type to OTel SpanKind.
 * All agent spans are treated as INTERNAL unless they represent inter-agent
 * messages, which are CLIENT/SERVER in nature — mapped to CLIENT.
 */
function toOtelSpanKind(type: Span["type"]): SpanKind {
  switch (type) {
    case "agent.message":
      return SpanKind.CLIENT;
    case "agent.workflow":
      return SpanKind.PRODUCER;
    default:
      return SpanKind.INTERNAL;
  }
}

/**
 * Builds OTel-compatible span attributes from AgentTrace span data, following
 * OpenTelemetry GenAI semantic conventions where applicable.
 *
 * https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
function toOtelAttributes(span: Span): OtelSpanAttributes {
  const attrs: OtelSpanAttributes = {
    "agenttrace.span.type": span.type,
  };

  const a = span.attributes;

  // GenAI semantic conventions for LLM calls
  if (span.type === "agent.llm_call") {
    if (a.model !== undefined) attrs["gen_ai.request.model"] = a.model;
    if (a.prompt_tokens !== undefined)
      attrs["gen_ai.usage.input_tokens"] = a.prompt_tokens;
    if (a.completion_tokens !== undefined)
      attrs["gen_ai.usage.output_tokens"] = a.completion_tokens;
    if (a.cost !== undefined) attrs["gen_ai.usage.cost"] = a.cost;
  }

  // Tool call attributes
  if (span.type === "agent.tool_call") {
    if (a.tool_name !== undefined) attrs["agenttrace.tool.name"] = a.tool_name;
    if (a.tool_args !== undefined) attrs["agenttrace.tool.args"] = a.tool_args;
    if (a.tool_result_summary !== undefined)
      attrs["agenttrace.tool.result_summary"] = a.tool_result_summary;
    if (a.tool_success !== undefined)
      attrs["agenttrace.tool.success"] = a.tool_success;
  }

  // Message attributes
  if (span.type === "agent.message") {
    if (a.from_agent !== undefined)
      attrs["agenttrace.message.from_agent"] = a.from_agent;
    if (a.to_agent !== undefined)
      attrs["agenttrace.message.to_agent"] = a.to_agent;
    if (a.content_summary !== undefined)
      attrs["agenttrace.message.content_summary"] = a.content_summary;
  }

  // Decision attributes
  if (span.type === "agent.decision") {
    if (a.decision_point !== undefined)
      attrs["agenttrace.decision.point"] = a.decision_point;
    if (a.choice_made !== undefined)
      attrs["agenttrace.decision.choice"] = a.choice_made;
    if (a.confidence !== undefined)
      attrs["agenttrace.decision.confidence"] = a.confidence;
    if (Array.isArray(a.options_considered))
      attrs["agenttrace.decision.options"] = a.options_considered.join(",");
  }

  // Workflow attributes
  if (span.type === "agent.workflow") {
    if (a.workflow_id !== undefined)
      attrs["agenttrace.workflow.id"] = a.workflow_id;
    if (a.topology !== undefined)
      attrs["agenttrace.workflow.topology"] = a.topology;
    if (a.workflow_status !== undefined)
      attrs["agenttrace.workflow.status"] = a.workflow_status;
  }

  // Common agent attributes
  if (a.agent_id !== undefined) attrs["agenttrace.agent.id"] = a.agent_id;
  if (a.agent_name !== undefined)
    attrs["agenttrace.agent.name"] = a.agent_name;

  return attrs;
}

/** Converts an AgentTrace Span to an OTel ReadableSpan. */
function toReadableSpan(
  span: Span,
  resource: Resource,
  instrumentationLibrary: InstrumentationLibrary
): ReadableSpan {
  const traceId = uuidToTraceId(span.trace_id);
  const spanId = uuidToSpanId(span.span_id);
  const parentSpanId = span.parent_span_id
    ? uuidToSpanId(span.parent_span_id)
    : undefined;

  const spanContext: SpanContext = {
    traceId,
    spanId,
    traceFlags: 1, // SAMPLED
    isRemote: false,
  };

  const startTime = msToHrTime(span.start_time);
  const endTime = msToHrTime(span.end_time);
  const duration = msToHrTime(span.duration_ms);

  const status = {
    code: toOtelStatusCode(span.status),
    message:
      span.status === "error"
        ? "error"
        : span.status === "timeout"
          ? "timeout"
          : undefined,
  };

  return {
    name: span.name,
    kind: toOtelSpanKind(span.type),
    spanContext: () => spanContext,
    startTime,
    endTime,
    duration,
    status,
    attributes: toOtelAttributes(span),
    links: [] as Link[],
    events: [] as TimedEvent[],
    resource,
    instrumentationLibrary,
    parentSpanId,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ended: true,
  };
}

/**
 * OtlpExporter — reads spans from a TraceStore and exports them to an
 * OpenTelemetry Collector via OTLP/HTTP.
 *
 * @example
 * ```ts
 * const exporter = new OtlpExporter(store, {
 *   url: "http://localhost:4318/v1/traces",
 *   serviceName: "my-agent-pipeline",
 * });
 *
 * await exporter.exportTrace("trace-uuid-here");
 * await exporter.exportAll({ status: "error" });
 * await exporter.shutdown();
 * ```
 */
export class OtlpExporter {
  private exporter: OTLPTraceExporter;
  private resource: Resource;
  private instrumentationLibrary: InstrumentationLibrary;

  constructor(
    private readonly store: TraceStore,
    options: OtlpExporterOptions
  ) {
    this.exporter = new OTLPTraceExporter({
      url: options.url,
      headers: options.headers,
    });

    this.resource = new Resource({
      "service.name": options.serviceName ?? "agenttrace-sdk",
      "service.version": options.serviceVersion ?? "0.2.0",
    });

    this.instrumentationLibrary = {
      name: "agenttrace-sdk",
      version: "0.1.0",
    };
  }

  /**
   * Exports all spans for a single trace to the configured OTLP endpoint.
   * Resolves when the export completes or rejects on failure.
   */
  async exportTrace(traceId: string): Promise<void> {
    const spans = this.store.getSpans(traceId);
    if (spans.length === 0) return;

    const readableSpans = spans.map((span) =>
      toReadableSpan(span, this.resource, this.instrumentationLibrary)
    );

    return this.sendSpans(readableSpans);
  }

  /**
   * Exports all traces matching the given filter. Each trace's spans are
   * sent in a single batched export call.
   */
  async exportAll(filter?: TraceFilter): Promise<void> {
    const traces = this.store.listTraces(filter);
    if (traces.length === 0) return;

    const allReadableSpans: ReadableSpan[] = [];

    for (const trace of traces) {
      const spans = this.store.getSpans(trace.trace_id);
      for (const span of spans) {
        allReadableSpans.push(
          toReadableSpan(span, this.resource, this.instrumentationLibrary)
        );
      }
    }

    if (allReadableSpans.length === 0) return;

    return this.sendSpans(allReadableSpans);
  }

  /** Shuts down the underlying OTLP exporter, flushing any pending exports. */
  async shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }

  private sendSpans(spans: ReadableSpan[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.exporter.export(spans, (result) => {
        if (result.error) {
          reject(result.error);
        } else {
          resolve();
        }
      });
    });
  }
}

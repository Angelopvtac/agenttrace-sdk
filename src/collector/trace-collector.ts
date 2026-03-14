/**
 * TraceCollector — OpenTelemetry-compatible span collection for agent events.
 *
 * Wraps OTel's tracing API to create structured spans for agent activities
 * (LLM calls, tool calls, messages, decisions, workflows) and persists them
 * to the TraceStore.
 */

import { trace, context, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { randomUUID } from "node:crypto";
import type {
  Span,
  Trace,
  SpanType,
  SpanStatus,
  SpanAttributes,
} from "../types.js";
import { TraceStore } from "../query/trace-store.js";
import { CostCalculator } from "../cost/cost-calculator.js";

export interface CollectorOptions {
  serviceName?: string;
  store: TraceStore;
  costCalculator?: CostCalculator;
}

export class TraceCollector {
  private store: TraceStore;
  private costCalculator: CostCalculator;
  private tracer: Tracer;

  /** Active trace metadata, keyed by trace_id. */
  private activeTraces = new Map<
    string,
    { agents: Set<string>; spanCount: number; totalCost: number; totalTokens: number }
  >();

  constructor(options: CollectorOptions) {
    this.store = options.store;
    this.costCalculator = options.costCalculator ?? new CostCalculator();
    this.tracer = trace.getTracer(options.serviceName ?? "agenttrace");
  }

  /**
   * Start a new trace (typically at workflow start).
   * Returns the trace_id to correlate all child spans.
   */
  startTrace(workflowId?: string): string {
    const traceId = randomUUID();
    this.activeTraces.set(traceId, {
      agents: new Set(),
      spanCount: 0,
      totalCost: 0,
      totalTokens: 0,
    });

    const now = Date.now();
    this.store.upsertTrace({
      trace_id: traceId,
      workflow_id: workflowId ?? null,
      root_span_id: null,
      start_time: now,
      end_time: now,
      duration_ms: 0,
      span_count: 0,
      total_cost: 0,
      total_tokens: 0,
      status: "ok",
      agents: [],
    });

    return traceId;
  }

  /**
   * Record an LLM call span.
   * Automatically calculates cost and creates a cost record.
   */
  recordLlmCall(
    traceId: string,
    attrs: {
      model: string;
      prompt_tokens: number;
      completion_tokens: number;
      duration_ms: number;
      agent_id: string;
      agent_name?: string;
      parent_span_id?: string;
      status?: SpanStatus;
      extraAttributes?: Record<string, unknown>;
    }
  ): Span {
    const cost = this.costCalculator.calculate(
      attrs.model,
      attrs.prompt_tokens,
      attrs.completion_tokens
    );
    const totalTokens = attrs.prompt_tokens + attrs.completion_tokens;
    const now = Date.now();

    const span = this.createSpan(traceId, {
      name: `llm.${attrs.model}`,
      type: "agent.llm_call",
      parent_span_id: attrs.parent_span_id ?? null,
      status: attrs.status ?? "ok",
      start_time: now - attrs.duration_ms,
      end_time: now,
      duration_ms: attrs.duration_ms,
      attributes: {
        model: attrs.model,
        prompt_tokens: attrs.prompt_tokens,
        completion_tokens: attrs.completion_tokens,
        cost,
        agent_id: attrs.agent_id,
        agent_name: attrs.agent_name,
        ...attrs.extraAttributes,
      },
    });

    // Create cost record
    this.store.insertCostRecord({
      span_id: span.span_id,
      trace_id: traceId,
      agent_id: attrs.agent_id,
      workflow_id: this.store.getTrace(traceId)?.workflow_id ?? null,
      model: attrs.model,
      prompt_tokens: attrs.prompt_tokens,
      completion_tokens: attrs.completion_tokens,
      total_tokens: totalTokens,
      cost,
      timestamp: now,
    });

    this.updateTraceTotals(traceId, attrs.agent_id, cost, totalTokens);

    return span;
  }

  /**
   * Record a tool call span.
   */
  recordToolCall(
    traceId: string,
    attrs: {
      tool_name: string;
      tool_args?: string;
      tool_result_summary?: string;
      success: boolean;
      duration_ms: number;
      agent_id: string;
      agent_name?: string;
      parent_span_id?: string;
    }
  ): Span {
    const now = Date.now();
    return this.createSpan(traceId, {
      name: `tool.${attrs.tool_name}`,
      type: "agent.tool_call",
      parent_span_id: attrs.parent_span_id ?? null,
      status: attrs.success ? "ok" : "error",
      start_time: now - attrs.duration_ms,
      end_time: now,
      duration_ms: attrs.duration_ms,
      attributes: {
        tool_name: attrs.tool_name,
        tool_args: attrs.tool_args,
        tool_result_summary: attrs.tool_result_summary,
        tool_success: attrs.success,
        agent_id: attrs.agent_id,
        agent_name: attrs.agent_name,
      },
    });
  }

  /**
   * Record an inter-agent message span.
   */
  recordMessage(
    traceId: string,
    attrs: {
      from_agent: string;
      to_agent: string;
      content_summary: string;
      duration_ms?: number;
      parent_span_id?: string;
    }
  ): Span {
    const now = Date.now();
    const durationMs = attrs.duration_ms ?? 0;
    return this.createSpan(traceId, {
      name: `msg.${attrs.from_agent}->${attrs.to_agent}`,
      type: "agent.message",
      parent_span_id: attrs.parent_span_id ?? null,
      status: "ok",
      start_time: now - durationMs,
      end_time: now,
      duration_ms: durationMs,
      attributes: {
        from_agent: attrs.from_agent,
        to_agent: attrs.to_agent,
        content_summary: attrs.content_summary,
        agent_id: attrs.from_agent,
      },
    });
  }

  /**
   * Record a decision point span.
   */
  recordDecision(
    traceId: string,
    attrs: {
      decision_point: string;
      options_considered: string[];
      choice_made: string;
      confidence: number;
      agent_id: string;
      agent_name?: string;
      duration_ms?: number;
      parent_span_id?: string;
    }
  ): Span {
    const now = Date.now();
    const durationMs = attrs.duration_ms ?? 0;
    return this.createSpan(traceId, {
      name: `decision.${attrs.decision_point}`,
      type: "agent.decision",
      parent_span_id: attrs.parent_span_id ?? null,
      status: "ok",
      start_time: now - durationMs,
      end_time: now,
      duration_ms: durationMs,
      attributes: {
        decision_point: attrs.decision_point,
        options_considered: attrs.options_considered,
        choice_made: attrs.choice_made,
        confidence: attrs.confidence,
        agent_id: attrs.agent_id,
        agent_name: attrs.agent_name,
      },
    });
  }

  /**
   * Record a workflow span (typically the root span of a trace).
   */
  recordWorkflow(
    traceId: string,
    attrs: {
      workflow_id: string;
      topology: string;
      status: SpanStatus;
      start_time: number;
      end_time: number;
      agent_id?: string;
    }
  ): Span {
    return this.createSpan(traceId, {
      name: `workflow.${attrs.workflow_id}`,
      type: "agent.workflow",
      parent_span_id: null,
      status: attrs.status,
      start_time: attrs.start_time,
      end_time: attrs.end_time,
      duration_ms: attrs.end_time - attrs.start_time,
      attributes: {
        workflow_id: attrs.workflow_id,
        topology: attrs.topology,
        workflow_status: attrs.status,
        agent_id: attrs.agent_id,
      },
    });
  }

  /**
   * End a trace, finalizing its aggregate metrics.
   */
  endTrace(traceId: string, status?: SpanStatus): Trace | null {
    const meta = this.activeTraces.get(traceId);
    const existing = this.store.getTrace(traceId);
    if (!existing) return null;

    const spans = this.store.getSpans(traceId);
    const now = Date.now();

    const startTime =
      spans.length > 0
        ? Math.min(...spans.map((s) => s.start_time))
        : existing.start_time;
    const endTime =
      spans.length > 0 ? Math.max(...spans.map((s) => s.end_time)) : now;

    const hasErrors = spans.some((s) => s.status === "error");
    const rootSpan = spans.find((s) => s.parent_span_id === null);

    const finalTrace: Trace = {
      trace_id: traceId,
      workflow_id: existing.workflow_id,
      root_span_id: rootSpan?.span_id ?? null,
      start_time: startTime,
      end_time: endTime,
      duration_ms: endTime - startTime,
      span_count: spans.length,
      total_cost: meta?.totalCost ?? existing.total_cost,
      total_tokens: meta?.totalTokens ?? existing.total_tokens,
      status: status ?? (hasErrors ? "error" : "ok"),
      agents: meta ? [...meta.agents] : existing.agents,
    };

    this.store.upsertTrace(finalTrace);
    this.activeTraces.delete(traceId);

    return finalTrace;
  }

  // --- Internal helpers ---

  private createSpan(
    traceId: string,
    opts: {
      name: string;
      type: SpanType;
      parent_span_id: string | null;
      status: SpanStatus;
      start_time: number;
      end_time: number;
      duration_ms: number;
      attributes: SpanAttributes;
    }
  ): Span {
    const span: Span = {
      span_id: randomUUID(),
      trace_id: traceId,
      parent_span_id: opts.parent_span_id,
      name: opts.name,
      type: opts.type,
      status: opts.status,
      start_time: opts.start_time,
      end_time: opts.end_time,
      duration_ms: opts.duration_ms,
      attributes: opts.attributes,
    };

    this.store.insertSpan(span);

    // Update active trace metadata
    const meta = this.activeTraces.get(traceId);
    if (meta) {
      meta.spanCount++;
      const agentId = opts.attributes.agent_id;
      if (agentId) meta.agents.add(agentId);
    }

    return span;
  }

  private updateTraceTotals(
    traceId: string,
    agentId: string,
    cost: number,
    tokens: number
  ): void {
    const meta = this.activeTraces.get(traceId);
    if (meta) {
      meta.totalCost += cost;
      meta.totalTokens += tokens;
      meta.agents.add(agentId);
    }
  }
}

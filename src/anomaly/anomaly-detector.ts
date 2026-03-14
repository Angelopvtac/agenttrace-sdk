/**
 * AnomalyDetector — Detects anomalous agent behavior by comparing
 * current span metrics against rolling baselines.
 *
 * Detection rules:
 * - Cost spike: cost exceeds 3x the agent's average
 * - Latency spike: duration exceeds 3x the agent's average
 * - Token spike: token usage exceeds 3x the agent's average
 * - Error cascade: error rate exceeds baseline by >20 percentage points
 * - Unusual tool usage: tool called at >5x normal frequency
 * - Loop detection: same tool called >N times with similar args in one trace
 */

import { randomUUID } from "node:crypto";
import type {
  Span,
  AnomalyAlert,
  AnomalyType,
  AnomalySeverity,
  BaselineMetrics,
} from "../types.js";
import { TraceStore } from "../query/trace-store.js";

export interface DetectorConfig {
  /** Multiplier threshold for spike detection (default: 3). */
  spikeThreshold?: number;
  /** Max repetitions of same tool before loop alert (default: 5). */
  loopThreshold?: number;
  /** Minimum samples before baselines are trusted (default: 10). */
  minSamples?: number;
}

export class AnomalyDetector {
  private store: TraceStore;
  private spikeThreshold: number;
  private loopThreshold: number;
  private minSamples: number;

  constructor(store: TraceStore, config: DetectorConfig = {}) {
    this.store = store;
    this.spikeThreshold = config.spikeThreshold ?? 3;
    this.loopThreshold = config.loopThreshold ?? 5;
    this.minSamples = config.minSamples ?? 10;
  }

  /**
   * Analyze a single span against agent baselines.
   * Returns any anomaly alerts detected.
   */
  analyzeSpan(span: Span): AnomalyAlert[] {
    const agentId = span.attributes.agent_id;
    if (!agentId) return [];

    const baseline = this.store.getBaseline(agentId);
    const alerts: AnomalyAlert[] = [];

    // Update baseline with this span's data
    this.updateBaselineFromSpan(agentId, span);

    // Skip anomaly checks until we have enough samples
    if (!baseline || baseline.sample_count < this.minSamples) return [];

    // Cost spike
    if (span.type === "agent.llm_call") {
      const cost = (span.attributes.cost as number) ?? 0;
      if (
        baseline.avg_cost_per_call > 0 &&
        cost > baseline.avg_cost_per_call * this.spikeThreshold
      ) {
        alerts.push(
          this.createAlert({
            type: "cost_spike",
            severity: cost > baseline.avg_cost_per_call * 10 ? "critical" : "warning",
            agent_id: agentId,
            trace_id: span.trace_id,
            span_id: span.span_id,
            metric: "cost",
            expected: baseline.avg_cost_per_call,
            actual: cost,
            evidence: `LLM call cost $${cost.toFixed(4)} vs avg $${baseline.avg_cost_per_call.toFixed(4)} (${(cost / baseline.avg_cost_per_call).toFixed(1)}x)`,
          })
        );
      }

      // Token spike
      const tokens =
        (span.attributes.prompt_tokens ?? 0) +
        (span.attributes.completion_tokens ?? 0);
      if (
        baseline.avg_tokens_per_call > 0 &&
        tokens > baseline.avg_tokens_per_call * this.spikeThreshold
      ) {
        alerts.push(
          this.createAlert({
            type: "token_spike",
            severity: "warning",
            agent_id: agentId,
            trace_id: span.trace_id,
            span_id: span.span_id,
            metric: "tokens",
            expected: baseline.avg_tokens_per_call,
            actual: tokens,
            evidence: `Token usage ${tokens} vs avg ${Math.round(baseline.avg_tokens_per_call)} (${(tokens / baseline.avg_tokens_per_call).toFixed(1)}x)`,
          })
        );
      }
    }

    // Latency spike
    if (
      baseline.avg_latency_ms > 0 &&
      span.duration_ms > baseline.avg_latency_ms * this.spikeThreshold
    ) {
      alerts.push(
        this.createAlert({
          type: "latency_spike",
          severity: span.duration_ms > baseline.avg_latency_ms * 10 ? "critical" : "warning",
          agent_id: agentId,
          trace_id: span.trace_id,
          span_id: span.span_id,
          metric: "latency_ms",
          expected: baseline.avg_latency_ms,
          actual: span.duration_ms,
          evidence: `Duration ${span.duration_ms}ms vs avg ${Math.round(baseline.avg_latency_ms)}ms (${(span.duration_ms / baseline.avg_latency_ms).toFixed(1)}x)`,
        })
      );
    }

    // Error cascade
    if (span.status === "error") {
      const recentSpans = this.store.getSpans(span.trace_id);
      const errorCount = recentSpans.filter(
        (s) => s.status === "error" && s.attributes.agent_id === agentId
      ).length;
      const errorRate = errorCount / Math.max(recentSpans.length, 1);

      if (errorRate - baseline.error_rate > 0.2) {
        alerts.push(
          this.createAlert({
            type: "error_cascade",
            severity: errorRate > 0.5 ? "critical" : "warning",
            agent_id: agentId,
            trace_id: span.trace_id,
            span_id: span.span_id,
            metric: "error_rate",
            expected: baseline.error_rate,
            actual: errorRate,
            evidence: `Error rate ${(errorRate * 100).toFixed(1)}% vs baseline ${(baseline.error_rate * 100).toFixed(1)}% (${errorCount} errors in trace)`,
          })
        );
      }
    }

    // Persist alerts
    for (const alert of alerts) {
      this.store.insertAnomaly(alert);
    }

    return alerts;
  }

  /**
   * Analyze an entire trace for loop detection and unusual tool usage.
   * Call this after all spans in a trace have been recorded.
   */
  analyzeTrace(traceId: string): AnomalyAlert[] {
    const spans = this.store.getSpans(traceId);
    const alerts: AnomalyAlert[] = [];

    // Group tool calls by agent
    const agentToolCalls = new Map<string, Map<string, Span[]>>();

    for (const span of spans) {
      if (span.type !== "agent.tool_call") continue;
      const agentId = span.attributes.agent_id ?? "unknown";
      const toolName = span.attributes.tool_name ?? "unknown";

      if (!agentToolCalls.has(agentId)) {
        agentToolCalls.set(agentId, new Map());
      }
      const tools = agentToolCalls.get(agentId)!;
      if (!tools.has(toolName)) {
        tools.set(toolName, []);
      }
      tools.get(toolName)!.push(span);
    }

    for (const [agentId, tools] of agentToolCalls) {
      for (const [toolName, calls] of tools) {
        // Loop detection: same tool called many times
        if (calls.length > this.loopThreshold) {
          // Check if args are similar (simple string comparison)
          const argSet = new Set(calls.map((c) => c.attributes.tool_args ?? ""));
          const similarArgs = argSet.size < calls.length * 0.5;

          if (similarArgs) {
            const alert = this.createAlert({
              type: "loop_detection",
              severity: calls.length > this.loopThreshold * 2 ? "critical" : "warning",
              agent_id: agentId,
              trace_id: traceId,
              span_id: calls[calls.length - 1].span_id,
              metric: "tool_call_count",
              expected: this.loopThreshold,
              actual: calls.length,
              evidence: `Tool "${toolName}" called ${calls.length} times with ${argSet.size} unique arg patterns (possible loop)`,
            });
            alerts.push(alert);
            this.store.insertAnomaly(alert);
          }
        }

        // Unusual tool usage frequency
        const baseline = this.store.getBaseline(agentId);
        if (
          baseline &&
          baseline.sample_count >= this.minSamples &&
          baseline.avg_tool_call_frequency > 0
        ) {
          const frequency = calls.length;
          if (frequency > baseline.avg_tool_call_frequency * 5) {
            const alert = this.createAlert({
              type: "unusual_tool_usage",
              severity: "warning",
              agent_id: agentId,
              trace_id: traceId,
              span_id: null,
              metric: "tool_frequency",
              expected: baseline.avg_tool_call_frequency,
              actual: frequency,
              evidence: `Tool "${toolName}" used ${frequency} times vs avg frequency ${baseline.avg_tool_call_frequency.toFixed(1)}`,
            });
            alerts.push(alert);
            this.store.insertAnomaly(alert);
          }
        }
      }
    }

    return alerts;
  }

  private updateBaselineFromSpan(agentId: string, span: Span): void {
    const tokens =
      span.type === "agent.llm_call"
        ? (span.attributes.prompt_tokens ?? 0) +
          (span.attributes.completion_tokens ?? 0)
        : undefined;

    const cost =
      span.type === "agent.llm_call"
        ? ((span.attributes.cost as number) ?? 0)
        : undefined;

    this.store.updateBaseline(agentId, {
      avg_latency_ms: span.duration_ms,
      avg_tokens_per_call: tokens,
      avg_cost_per_call: cost,
      error_rate: span.status === "error" ? 1 : 0,
    });
  }

  private createAlert(
    params: Omit<AnomalyAlert, "id" | "timestamp">
  ): AnomalyAlert {
    return {
      id: randomUUID(),
      timestamp: Date.now(),
      ...params,
    };
  }
}

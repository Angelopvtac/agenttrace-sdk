/**
 * AgentTrace — Cross-Agent Observability Platform
 *
 * The "call stack for AI": trace, attribute costs, detect anomalies,
 * and visualize multi-agent workflows.
 *
 * @example
 * ```ts
 * import { TraceStore, TraceCollector, CostCalculator, CostAttributor, FlameGraphBuilder, AnomalyDetector } from "agenttrace";
 *
 * const store = new TraceStore("./traces.db");
 * const collector = new TraceCollector({ store });
 * const costs = new CostAttributor(store);
 * const flames = new FlameGraphBuilder(store);
 * const anomalies = new AnomalyDetector(store);
 *
 * // Start tracing a workflow
 * const traceId = collector.startTrace("workflow-123");
 *
 * // Record agent activities
 * collector.recordLlmCall(traceId, {
 *   model: "claude-sonnet-4-6",
 *   prompt_tokens: 1500,
 *   completion_tokens: 800,
 *   duration_ms: 2300,
 *   agent_id: "planner",
 * });
 *
 * // End trace and get summary
 * const trace = collector.endTrace(traceId);
 *
 * // Query costs
 * const breakdown = costs.getCostBreakdown("workflow-123");
 *
 * // Generate flame graph
 * const flameJson = flames.exportJson(traceId);
 * ```
 */

// Types
export type {
  Span,
  Trace,
  SpanType,
  SpanStatus,
  SpanAttributes,
  CostRecord,
  FlameNode,
  AnomalyAlert,
  AnomalyType,
  AnomalySeverity,
  BaselineMetrics,
  TraceFilter,
  CostBreakdownEntry,
  ModelPricing,
} from "./types.js";

// Collector
export { TraceCollector } from "./collector/trace-collector.js";
export type { CollectorOptions } from "./collector/trace-collector.js";

// Cost
export { CostCalculator } from "./cost/cost-calculator.js";
export { CostAttributor } from "./cost/cost-attributor.js";

// Flame Graph
export { FlameGraphBuilder } from "./flamegraph/flame-graph.js";

// Anomaly Detection
export { AnomalyDetector } from "./anomaly/anomaly-detector.js";
export type { DetectorConfig } from "./anomaly/anomaly-detector.js";

// Storage & Query
export { TraceStore } from "./query/trace-store.js";

// Export
export { OtlpExporter } from "./export/otlp-exporter.js";
export type { OtlpExporterOptions } from "./export/otlp-exporter.js";

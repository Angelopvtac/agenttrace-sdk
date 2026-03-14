/**
 * Core type definitions for AgentTrace observability platform.
 */

/** Span types representing different agent activities. */
export type SpanType =
  | "agent.llm_call"
  | "agent.tool_call"
  | "agent.message"
  | "agent.decision"
  | "agent.workflow";

/** Status of a span execution. */
export type SpanStatus = "ok" | "error" | "timeout";

/** Severity levels for anomaly alerts. */
export type AnomalySeverity = "info" | "warning" | "critical";

/** Types of anomalies the detector can identify. */
export type AnomalyType =
  | "cost_spike"
  | "latency_spike"
  | "error_cascade"
  | "unusual_tool_usage"
  | "loop_detection"
  | "token_spike";

/** Attributes attached to a span, varying by SpanType. */
export interface SpanAttributes {
  // LLM call attributes
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;

  // Tool call attributes
  tool_name?: string;
  tool_args?: string;
  tool_result_summary?: string;
  tool_success?: boolean;

  // Message attributes
  from_agent?: string;
  to_agent?: string;
  content_summary?: string;

  // Decision attributes
  decision_point?: string;
  options_considered?: string[];
  choice_made?: string;
  confidence?: number;

  // Workflow attributes
  workflow_id?: string;
  topology?: string;
  workflow_status?: string;

  // Common
  agent_id?: string;
  agent_name?: string;

  [key: string]: unknown;
}

/** A single span representing one unit of agent work. */
export interface Span {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  type: SpanType;
  status: SpanStatus;
  start_time: number;
  end_time: number;
  duration_ms: number;
  attributes: SpanAttributes;
}

/** A trace is a collection of correlated spans forming a complete execution. */
export interface Trace {
  trace_id: string;
  workflow_id: string | null;
  root_span_id: string | null;
  start_time: number;
  end_time: number;
  duration_ms: number;
  span_count: number;
  total_cost: number;
  total_tokens: number;
  status: SpanStatus;
  agents: string[];
}

/** A cost record for attribution. */
export interface CostRecord {
  span_id: string;
  trace_id: string;
  agent_id: string;
  workflow_id: string | null;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  timestamp: number;
}

/** A node in the flame graph tree. */
export interface FlameNode {
  name: string;
  type: SpanType;
  span_id: string;
  start_time: number;
  duration: number;
  cost: number;
  tokens: number;
  status: SpanStatus;
  attributes: SpanAttributes;
  children: FlameNode[];
}

/** An anomaly alert raised by the detector. */
export interface AnomalyAlert {
  id: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  agent_id: string;
  trace_id: string;
  span_id: string | null;
  metric: string;
  expected: number;
  actual: number;
  evidence: string;
  timestamp: number;
}

/** Rolling baseline metrics for an agent. */
export interface BaselineMetrics {
  agent_id: string;
  avg_tool_call_frequency: number;
  avg_tokens_per_call: number;
  avg_cost_per_call: number;
  avg_latency_ms: number;
  error_rate: number;
  sample_count: number;
  last_updated: number;
}

/** Filter criteria for querying traces. */
export interface TraceFilter {
  start_time?: number;
  end_time?: number;
  agent_id?: string;
  workflow_id?: string;
  status?: SpanStatus;
  min_cost?: number;
  max_cost?: number;
  has_anomaly?: boolean;
  limit?: number;
  offset?: number;
}

/** Cost breakdown entry for attribution reports. */
export interface CostBreakdownEntry {
  key: string;
  label: string;
  total_cost: number;
  total_tokens: number;
  call_count: number;
  avg_cost_per_call: number;
}

/** Model pricing configuration. */
export interface ModelPricing {
  model: string;
  input_cost_per_million: number;
  output_cost_per_million: number;
}

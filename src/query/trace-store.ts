/**
 * TraceStore — SQLite-backed storage for spans, traces, costs, baselines, and anomalies.
 * Provides the persistence layer for the entire AgentTrace platform.
 */

import Database from "better-sqlite3";
import type {
  Span,
  Trace,
  CostRecord,
  TraceFilter,
  BaselineMetrics,
  AnomalyAlert,
  SpanAttributes,
  SpanType,
  SpanStatus,
} from "../types.js";

export class TraceStore {
  private db: Database.Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spans (
        span_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        parent_span_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ok',
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        attributes TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
      CREATE INDEX IF NOT EXISTS idx_spans_parent ON spans(parent_span_id);
      CREATE INDEX IF NOT EXISTS idx_spans_type ON spans(type);
      CREATE INDEX IF NOT EXISTS idx_spans_time ON spans(start_time);

      CREATE TABLE IF NOT EXISTS traces (
        trace_id TEXT PRIMARY KEY,
        workflow_id TEXT,
        root_span_id TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        span_count INTEGER NOT NULL DEFAULT 0,
        total_cost REAL NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok',
        agents TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_traces_workflow ON traces(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_traces_time ON traces(start_time);
      CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);

      CREATE TABLE IF NOT EXISTS cost_records (
        span_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        workflow_id TEXT,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        cost REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_costs_trace ON cost_records(trace_id);
      CREATE INDEX IF NOT EXISTS idx_costs_agent ON cost_records(agent_id);
      CREATE INDEX IF NOT EXISTS idx_costs_workflow ON cost_records(workflow_id);

      CREATE TABLE IF NOT EXISTS baselines (
        agent_id TEXT PRIMARY KEY,
        avg_tool_call_frequency REAL NOT NULL DEFAULT 0,
        avg_tokens_per_call REAL NOT NULL DEFAULT 0,
        avg_cost_per_call REAL NOT NULL DEFAULT 0,
        avg_latency_ms REAL NOT NULL DEFAULT 0,
        error_rate REAL NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        last_updated INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS anomalies (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        span_id TEXT,
        metric TEXT NOT NULL,
        expected REAL NOT NULL,
        actual REAL NOT NULL,
        evidence TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_anomalies_trace ON anomalies(trace_id);
      CREATE INDEX IF NOT EXISTS idx_anomalies_agent ON anomalies(agent_id);
      CREATE INDEX IF NOT EXISTS idx_anomalies_severity ON anomalies(severity);
    `);
  }

  // --- Span operations ---

  /** Insert a span into storage. */
  insertSpan(span: Span): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO spans (span_id, trace_id, parent_span_id, name, type, status, start_time, end_time, duration_ms, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        span.span_id,
        span.trace_id,
        span.parent_span_id,
        span.name,
        span.type,
        span.status,
        span.start_time,
        span.end_time,
        span.duration_ms,
        JSON.stringify(span.attributes)
      );
  }

  /** Retrieve all spans for a given trace. */
  getSpans(traceId: string): Span[] {
    const rows = this.db
      .prepare("SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time")
      .all(traceId) as SpanRow[];
    return rows.map(deserializeSpan);
  }

  /** Search spans by name or attribute content. */
  searchSpans(query: string): Span[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM spans
       WHERE name LIKE ? OR attributes LIKE ?
       ORDER BY start_time DESC LIMIT 100`
      )
      .all(`%${query}%`, `%${query}%`) as SpanRow[];
    return rows.map(deserializeSpan);
  }

  /** Get a single span by ID. */
  getSpan(spanId: string): Span | null {
    const row = this.db
      .prepare("SELECT * FROM spans WHERE span_id = ?")
      .get(spanId) as SpanRow | undefined;
    return row ? deserializeSpan(row) : null;
  }

  // --- Trace operations ---

  /** Insert or update a trace record. */
  upsertTrace(trace: Trace): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO traces (trace_id, workflow_id, root_span_id, start_time, end_time, duration_ms, span_count, total_cost, total_tokens, status, agents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        trace.trace_id,
        trace.workflow_id,
        trace.root_span_id,
        trace.start_time,
        trace.end_time,
        trace.duration_ms,
        trace.span_count,
        trace.total_cost,
        trace.total_tokens,
        trace.status,
        JSON.stringify(trace.agents)
      );
  }

  /** Retrieve a trace by ID. */
  getTrace(traceId: string): Trace | null {
    const row = this.db
      .prepare("SELECT * FROM traces WHERE trace_id = ?")
      .get(traceId) as TraceRow | undefined;
    return row ? deserializeTrace(row) : null;
  }

  /** List traces matching the given filter. */
  listTraces(filter: TraceFilter = {}): Trace[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.start_time !== undefined) {
      conditions.push("t.start_time >= ?");
      params.push(filter.start_time);
    }
    if (filter.end_time !== undefined) {
      conditions.push("t.end_time <= ?");
      params.push(filter.end_time);
    }
    if (filter.workflow_id !== undefined) {
      conditions.push("t.workflow_id = ?");
      params.push(filter.workflow_id);
    }
    if (filter.status !== undefined) {
      conditions.push("t.status = ?");
      params.push(filter.status);
    }
    if (filter.min_cost !== undefined) {
      conditions.push("t.total_cost >= ?");
      params.push(filter.min_cost);
    }
    if (filter.max_cost !== undefined) {
      conditions.push("t.total_cost <= ?");
      params.push(filter.max_cost);
    }
    if (filter.agent_id !== undefined) {
      conditions.push("t.agents LIKE ?");
      params.push(`%"${filter.agent_id}"%`);
    }
    if (filter.has_anomaly) {
      conditions.push(
        "EXISTS (SELECT 1 FROM anomalies a WHERE a.trace_id = t.trace_id)"
      );
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;

    const rows = this.db
      .prepare(
        `SELECT t.* FROM traces t ${where} ORDER BY t.start_time DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as TraceRow[];

    return rows.map(deserializeTrace);
  }

  // --- Cost operations ---

  /** Insert a cost record. */
  insertCostRecord(record: CostRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cost_records (span_id, trace_id, agent_id, workflow_id, model, prompt_tokens, completion_tokens, total_tokens, cost, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.span_id,
        record.trace_id,
        record.agent_id,
        record.workflow_id,
        record.model,
        record.prompt_tokens,
        record.completion_tokens,
        record.total_tokens,
        record.cost,
        record.timestamp
      );
  }

  /** Get all cost records for a workflow. */
  getCostsByWorkflow(workflowId: string): CostRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM cost_records WHERE workflow_id = ? ORDER BY timestamp"
      )
      .all(workflowId) as CostRecord[];
  }

  /** Get all cost records for an agent. */
  getCostsByAgent(agentId: string): CostRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM cost_records WHERE agent_id = ? ORDER BY timestamp"
      )
      .all(agentId) as CostRecord[];
  }

  /** Get all cost records for a trace. */
  getCostsByTrace(traceId: string): CostRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM cost_records WHERE trace_id = ? ORDER BY timestamp"
      )
      .all(traceId) as CostRecord[];
  }

  // --- Baseline operations ---

  /** Get or create baseline metrics for an agent. */
  getBaseline(agentId: string): BaselineMetrics | null {
    const row = this.db
      .prepare("SELECT * FROM baselines WHERE agent_id = ?")
      .get(agentId) as BaselineMetrics | undefined;
    return row ?? null;
  }

  /** Update baseline metrics for an agent with a new sample. */
  updateBaseline(agentId: string, sample: Partial<BaselineMetrics>): void {
    const existing = this.getBaseline(agentId);
    const now = Date.now();

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO baselines (agent_id, avg_tool_call_frequency, avg_tokens_per_call, avg_cost_per_call, avg_latency_ms, error_rate, sample_count, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .run(
          agentId,
          sample.avg_tool_call_frequency ?? 0,
          sample.avg_tokens_per_call ?? 0,
          sample.avg_cost_per_call ?? 0,
          sample.avg_latency_ms ?? 0,
          sample.error_rate ?? 0,
          now
        );
      return;
    }

    // Exponential moving average with alpha = 2/(n+1), capped at n=100
    const n = Math.min(existing.sample_count, 100);
    const alpha = 2 / (n + 1);

    const ema = (prev: number, next: number | undefined) =>
      next !== undefined ? prev * (1 - alpha) + next * alpha : prev;

    this.db
      .prepare(
        `UPDATE baselines SET
        avg_tool_call_frequency = ?,
        avg_tokens_per_call = ?,
        avg_cost_per_call = ?,
        avg_latency_ms = ?,
        error_rate = ?,
        sample_count = sample_count + 1,
        last_updated = ?
       WHERE agent_id = ?`
      )
      .run(
        ema(existing.avg_tool_call_frequency, sample.avg_tool_call_frequency),
        ema(existing.avg_tokens_per_call, sample.avg_tokens_per_call),
        ema(existing.avg_cost_per_call, sample.avg_cost_per_call),
        ema(existing.avg_latency_ms, sample.avg_latency_ms),
        ema(existing.error_rate, sample.error_rate),
        now,
        agentId
      );
  }

  // --- Anomaly operations ---

  /** Insert an anomaly alert. */
  insertAnomaly(alert: AnomalyAlert): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO anomalies (id, type, severity, agent_id, trace_id, span_id, metric, expected, actual, evidence, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        alert.id,
        alert.type,
        alert.severity,
        alert.agent_id,
        alert.trace_id,
        alert.span_id,
        alert.metric,
        alert.expected,
        alert.actual,
        alert.evidence,
        alert.timestamp
      );
  }

  /** Get anomalies for a trace. */
  getAnomaliesByTrace(traceId: string): AnomalyAlert[] {
    return this.db
      .prepare(
        "SELECT * FROM anomalies WHERE trace_id = ? ORDER BY timestamp"
      )
      .all(traceId) as AnomalyAlert[];
  }

  /** Get anomalies for an agent. */
  getAnomaliesByAgent(agentId: string): AnomalyAlert[] {
    return this.db
      .prepare(
        "SELECT * FROM anomalies WHERE agent_id = ? ORDER BY timestamp DESC"
      )
      .all(agentId) as AnomalyAlert[];
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}

// --- Internal row types and deserialization ---

interface SpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  type: string;
  status: string;
  start_time: number;
  end_time: number;
  duration_ms: number;
  attributes: string;
}

interface TraceRow {
  trace_id: string;
  workflow_id: string | null;
  root_span_id: string | null;
  start_time: number;
  end_time: number;
  duration_ms: number;
  span_count: number;
  total_cost: number;
  total_tokens: number;
  status: string;
  agents: string;
}

function deserializeSpan(row: SpanRow): Span {
  return {
    ...row,
    type: row.type as SpanType,
    status: row.status as SpanStatus,
    attributes: JSON.parse(row.attributes) as SpanAttributes,
  };
}

function deserializeTrace(row: TraceRow): Trace {
  return {
    ...row,
    status: row.status as SpanStatus,
    agents: JSON.parse(row.agents) as string[],
  };
}

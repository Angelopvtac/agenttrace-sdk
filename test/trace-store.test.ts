import { describe, it, expect, beforeEach } from "vitest";
import { TraceStore } from "../src/index.js";
import type { Span, Trace, CostRecord, AnomalyAlert } from "../src/index.js";

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    span_id: "span-001",
    trace_id: "trace-001",
    parent_span_id: null,
    name: "test.span",
    type: "agent.llm_call",
    status: "ok",
    start_time: 1000,
    end_time: 2000,
    duration_ms: 1000,
    attributes: { agent_id: "agent-a" },
    ...overrides,
  };
}

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    trace_id: "trace-001",
    workflow_id: "wf-001",
    root_span_id: null,
    start_time: 1000,
    end_time: 5000,
    duration_ms: 4000,
    span_count: 1,
    total_cost: 0.01,
    total_tokens: 500,
    status: "ok",
    agents: ["agent-a"],
    ...overrides,
  };
}

function makeCostRecord(overrides: Partial<CostRecord> = {}): CostRecord {
  return {
    span_id: "span-001",
    trace_id: "trace-001",
    agent_id: "agent-a",
    workflow_id: "wf-001",
    model: "claude-sonnet-4-6",
    prompt_tokens: 300,
    completion_tokens: 200,
    total_tokens: 500,
    cost: 0.004,
    timestamp: 1000,
    ...overrides,
  };
}

function makeAnomaly(overrides: Partial<AnomalyAlert> = {}): AnomalyAlert {
  return {
    id: "alert-001",
    type: "cost_spike",
    severity: "warning",
    agent_id: "agent-a",
    trace_id: "trace-001",
    span_id: "span-001",
    metric: "cost",
    expected: 0.001,
    actual: 0.01,
    evidence: "10x cost spike",
    timestamp: 1000,
    ...overrides,
  };
}

describe("TraceStore", () => {
  let store: TraceStore;

  beforeEach(() => {
    store = new TraceStore(":memory:");
  });

  describe("Span operations", () => {
    it("inserts and retrieves a span by ID", () => {
      const span = makeSpan();
      store.insertSpan(span);
      const retrieved = store.getSpan("span-001");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.span_id).toBe("span-001");
      expect(retrieved!.name).toBe("test.span");
    });

    it("returns null for a non-existent span", () => {
      expect(store.getSpan("does-not-exist")).toBeNull();
    });

    it("deserializes attributes from JSON correctly", () => {
      const span = makeSpan({ attributes: { agent_id: "agent-a", model: "claude-sonnet-4-6", cost: 0.005 } });
      store.insertSpan(span);
      const retrieved = store.getSpan("span-001");
      expect(retrieved!.attributes.model).toBe("claude-sonnet-4-6");
      expect(retrieved!.attributes.cost).toBe(0.005);
    });

    it("retrieves all spans for a trace ordered by start_time", () => {
      store.insertSpan(makeSpan({ span_id: "span-002", start_time: 2000, end_time: 3000 }));
      store.insertSpan(makeSpan({ span_id: "span-001", start_time: 1000, end_time: 2000 }));
      const spans = store.getSpans("trace-001");
      expect(spans).toHaveLength(2);
      expect(spans[0].span_id).toBe("span-001");
      expect(spans[1].span_id).toBe("span-002");
    });

    it("returns empty array when no spans exist for a trace", () => {
      expect(store.getSpans("nonexistent-trace")).toHaveLength(0);
    });

    it("replaces a span on duplicate insert (INSERT OR REPLACE)", () => {
      store.insertSpan(makeSpan({ name: "original" }));
      store.insertSpan(makeSpan({ name: "replaced" }));
      expect(store.getSpan("span-001")!.name).toBe("replaced");
    });

    it("searches spans by name", () => {
      store.insertSpan(makeSpan({ name: "tool.read_file" }));
      store.insertSpan(makeSpan({ span_id: "span-002", name: "llm.claude" }));
      const results = store.searchSpans("read_file");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("tool.read_file");
    });

    it("searches spans by attribute content", () => {
      store.insertSpan(makeSpan({ attributes: { tool_name: "bash_exec", agent_id: "agent-a" } }));
      store.insertSpan(makeSpan({ span_id: "span-002", attributes: { tool_name: "web_search", agent_id: "agent-a" } }));
      const results = store.searchSpans("bash_exec");
      expect(results).toHaveLength(1);
    });

    it("returns empty array when search finds no matches", () => {
      store.insertSpan(makeSpan());
      expect(store.searchSpans("xyz-no-match")).toHaveLength(0);
    });

    it("stores and retrieves parent_span_id", () => {
      const parent = makeSpan({ span_id: "parent-1" });
      const child = makeSpan({ span_id: "child-1", parent_span_id: "parent-1" });
      store.insertSpan(parent);
      store.insertSpan(child);
      expect(store.getSpan("child-1")!.parent_span_id).toBe("parent-1");
      expect(store.getSpan("parent-1")!.parent_span_id).toBeNull();
    });
  });

  describe("Trace operations", () => {
    it("upserts and retrieves a trace by ID", () => {
      const trace = makeTrace();
      store.upsertTrace(trace);
      const retrieved = store.getTrace("trace-001");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.trace_id).toBe("trace-001");
      expect(retrieved!.total_cost).toBe(0.01);
    });

    it("returns null for a non-existent trace", () => {
      expect(store.getTrace("does-not-exist")).toBeNull();
    });

    it("deserializes agents array from JSON", () => {
      store.upsertTrace(makeTrace({ agents: ["agent-a", "agent-b"] }));
      expect(store.getTrace("trace-001")!.agents).toEqual(["agent-a", "agent-b"]);
    });

    it("updates an existing trace on upsert", () => {
      store.upsertTrace(makeTrace({ total_cost: 0.01 }));
      store.upsertTrace(makeTrace({ total_cost: 0.05 }));
      expect(store.getTrace("trace-001")!.total_cost).toBe(0.05);
    });

    it("lists all traces when no filter is provided", () => {
      store.upsertTrace(makeTrace({ trace_id: "t1" }));
      store.upsertTrace(makeTrace({ trace_id: "t2" }));
      expect(store.listTraces()).toHaveLength(2);
    });

    it("filters traces by workflow_id", () => {
      store.upsertTrace(makeTrace({ trace_id: "t1", workflow_id: "wf-A" }));
      store.upsertTrace(makeTrace({ trace_id: "t2", workflow_id: "wf-B" }));
      const results = store.listTraces({ workflow_id: "wf-A" });
      expect(results).toHaveLength(1);
      expect(results[0].trace_id).toBe("t1");
    });

    it("filters traces by status", () => {
      store.upsertTrace(makeTrace({ trace_id: "t1", status: "ok" }));
      store.upsertTrace(makeTrace({ trace_id: "t2", status: "error" }));
      const errors = store.listTraces({ status: "error" });
      expect(errors).toHaveLength(1);
      expect(errors[0].trace_id).toBe("t2");
    });

    it("filters traces by min_cost", () => {
      store.upsertTrace(makeTrace({ trace_id: "t1", total_cost: 0.001 }));
      store.upsertTrace(makeTrace({ trace_id: "t2", total_cost: 0.5 }));
      const expensive = store.listTraces({ min_cost: 0.1 });
      expect(expensive).toHaveLength(1);
      expect(expensive[0].trace_id).toBe("t2");
    });

    it("filters traces by max_cost", () => {
      store.upsertTrace(makeTrace({ trace_id: "t1", total_cost: 0.001 }));
      store.upsertTrace(makeTrace({ trace_id: "t2", total_cost: 0.5 }));
      const cheap = store.listTraces({ max_cost: 0.1 });
      expect(cheap).toHaveLength(1);
      expect(cheap[0].trace_id).toBe("t1");
    });

    it("filters traces by start_time and end_time", () => {
      store.upsertTrace(makeTrace({ trace_id: "t1", start_time: 100, end_time: 200 }));
      store.upsertTrace(makeTrace({ trace_id: "t2", start_time: 500, end_time: 600 }));
      const results = store.listTraces({ start_time: 400, end_time: 700 });
      expect(results).toHaveLength(1);
      expect(results[0].trace_id).toBe("t2");
    });

    it("filters traces by agent_id (substring in agents JSON)", () => {
      store.upsertTrace(makeTrace({ trace_id: "t1", agents: ["agent-a"] }));
      store.upsertTrace(makeTrace({ trace_id: "t2", agents: ["agent-b"] }));
      const results = store.listTraces({ agent_id: "agent-a" });
      expect(results).toHaveLength(1);
      expect(results[0].trace_id).toBe("t1");
    });

    it("filters traces by has_anomaly", () => {
      store.upsertTrace(makeTrace({ trace_id: "t1" }));
      store.upsertTrace(makeTrace({ trace_id: "t2" }));
      store.insertAnomaly(makeAnomaly({ trace_id: "t1" }));
      const withAnomaly = store.listTraces({ has_anomaly: true });
      expect(withAnomaly).toHaveLength(1);
      expect(withAnomaly[0].trace_id).toBe("t1");
    });

    it("respects limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        store.upsertTrace(makeTrace({ trace_id: `t${i}`, start_time: i * 100 }));
      }
      const page1 = store.listTraces({ limit: 2, offset: 0 });
      const page2 = store.listTraces({ limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].trace_id).not.toBe(page2[0].trace_id);
    });
  });

  describe("Cost record operations", () => {
    it("inserts and retrieves cost records by workflow", () => {
      store.insertCostRecord(makeCostRecord());
      const records = store.getCostsByWorkflow("wf-001");
      expect(records).toHaveLength(1);
      expect(records[0].cost).toBe(0.004);
    });

    it("retrieves cost records by agent", () => {
      store.insertCostRecord(makeCostRecord({ agent_id: "agent-a" }));
      store.insertCostRecord(makeCostRecord({ span_id: "span-002", agent_id: "agent-b" }));
      expect(store.getCostsByAgent("agent-a")).toHaveLength(1);
      expect(store.getCostsByAgent("agent-b")).toHaveLength(1);
    });

    it("retrieves cost records by trace", () => {
      store.insertCostRecord(makeCostRecord({ trace_id: "trace-001" }));
      store.insertCostRecord(makeCostRecord({ span_id: "span-002", trace_id: "trace-002" }));
      expect(store.getCostsByTrace("trace-001")).toHaveLength(1);
      expect(store.getCostsByTrace("trace-002")).toHaveLength(1);
    });

    it("returns empty array when no records exist", () => {
      expect(store.getCostsByWorkflow("nonexistent")).toHaveLength(0);
      expect(store.getCostsByAgent("nonexistent")).toHaveLength(0);
      expect(store.getCostsByTrace("nonexistent")).toHaveLength(0);
    });

    it("replaces an existing cost record with the same span_id", () => {
      store.insertCostRecord(makeCostRecord({ cost: 0.001 }));
      store.insertCostRecord(makeCostRecord({ cost: 0.999 }));
      expect(store.getCostsByTrace("trace-001")[0].cost).toBe(0.999);
    });
  });

  describe("Baseline operations", () => {
    it("returns null for unknown agent", () => {
      expect(store.getBaseline("nobody")).toBeNull();
    });

    it("creates a baseline on first updateBaseline call", () => {
      store.updateBaseline("agent-a", { avg_latency_ms: 500, avg_cost_per_call: 0.01 });
      const baseline = store.getBaseline("agent-a");
      expect(baseline).not.toBeNull();
      expect(baseline!.agent_id).toBe("agent-a");
      expect(baseline!.avg_latency_ms).toBe(500);
      expect(baseline!.sample_count).toBe(1);
    });

    it("applies EMA on subsequent updates", () => {
      store.updateBaseline("agent-a", { avg_latency_ms: 100 });
      store.updateBaseline("agent-a", { avg_latency_ms: 200 });
      const baseline = store.getBaseline("agent-a");
      // After 2 samples, alpha = 2/(1+1) = 1.0, so EMA = 100 * 0 + 200 * 1 = 200
      // Actually: n = min(1, 100) = 1, alpha = 2/(1+1) = 1.0
      expect(baseline!.sample_count).toBe(2);
      // EMA with alpha=1: result = 100 * 0 + 200 * 1 = 200
      expect(baseline!.avg_latency_ms).toBeCloseTo(200, 5);
    });

    it("increments sample_count on each update", () => {
      store.updateBaseline("agent-a", {});
      store.updateBaseline("agent-a", {});
      store.updateBaseline("agent-a", {});
      expect(store.getBaseline("agent-a")!.sample_count).toBe(3);
    });
  });

  describe("Anomaly operations", () => {
    it("inserts and retrieves anomalies by trace", () => {
      store.insertAnomaly(makeAnomaly());
      const anomalies = store.getAnomaliesByTrace("trace-001");
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].type).toBe("cost_spike");
    });

    it("retrieves anomalies by agent", () => {
      store.insertAnomaly(makeAnomaly({ id: "a1", agent_id: "agent-a" }));
      store.insertAnomaly(makeAnomaly({ id: "a2", agent_id: "agent-b" }));
      expect(store.getAnomaliesByAgent("agent-a")).toHaveLength(1);
      expect(store.getAnomaliesByAgent("agent-b")).toHaveLength(1);
    });

    it("returns empty array when no anomalies exist", () => {
      expect(store.getAnomaliesByTrace("no-trace")).toHaveLength(0);
      expect(store.getAnomaliesByAgent("nobody")).toHaveLength(0);
    });

    it("stores all alert fields correctly", () => {
      const alert = makeAnomaly({ severity: "critical", expected: 0.001, actual: 0.1 });
      store.insertAnomaly(alert);
      const retrieved = store.getAnomaliesByTrace("trace-001")[0];
      expect(retrieved.severity).toBe("critical");
      expect(retrieved.expected).toBe(0.001);
      expect(retrieved.actual).toBe(0.1);
      expect(retrieved.evidence).toBe("10x cost spike");
    });
  });

  describe("close()", () => {
    it("closes the database without throwing", () => {
      expect(() => store.close()).not.toThrow();
    });
  });
});

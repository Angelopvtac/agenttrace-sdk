import { describe, it, expect, beforeEach } from "vitest";
import { TraceStore, CostAttributor } from "../src/index.js";
import type { CostRecord } from "../src/index.js";

function makeCostRecord(overrides: Partial<CostRecord> = {}): CostRecord {
  return {
    span_id: `span-${Math.random()}`,
    trace_id: "trace-001",
    agent_id: "agent-a",
    workflow_id: "wf-001",
    model: "claude-sonnet-4-6",
    prompt_tokens: 300,
    completion_tokens: 200,
    total_tokens: 500,
    cost: 0.004,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("CostAttributor", () => {
  let store: TraceStore;
  let attributor: CostAttributor;

  beforeEach(() => {
    store = new TraceStore(":memory:");
    attributor = new CostAttributor(store);
  });

  describe("getCostByWorkflow()", () => {
    it("returns 0 when no records exist for the workflow", () => {
      expect(attributor.getCostByWorkflow("nonexistent")).toBe(0);
    });

    it("sums costs across all records for a workflow", () => {
      store.insertCostRecord(makeCostRecord({ workflow_id: "wf-A", cost: 0.01 }));
      store.insertCostRecord(makeCostRecord({ workflow_id: "wf-A", cost: 0.02 }));
      store.insertCostRecord(makeCostRecord({ workflow_id: "wf-B", cost: 0.99 })); // different workflow
      expect(attributor.getCostByWorkflow("wf-A")).toBeCloseTo(0.03, 6);
    });

    it("is not affected by records from other workflows", () => {
      store.insertCostRecord(makeCostRecord({ workflow_id: "wf-X", cost: 100 }));
      expect(attributor.getCostByWorkflow("wf-Y")).toBe(0);
    });
  });

  describe("getCostByAgent()", () => {
    it("returns 0 when no records exist for the agent", () => {
      expect(attributor.getCostByAgent("nobody")).toBe(0);
    });

    it("sums costs across all records for an agent", () => {
      store.insertCostRecord(makeCostRecord({ agent_id: "agent-a", cost: 0.005 }));
      store.insertCostRecord(makeCostRecord({ agent_id: "agent-a", cost: 0.010 }));
      store.insertCostRecord(makeCostRecord({ agent_id: "agent-b", cost: 0.999 })); // different agent
      expect(attributor.getCostByAgent("agent-a")).toBeCloseTo(0.015, 6);
    });
  });

  describe("getCostBreakdown()", () => {
    it("returns empty array when workflow has no records", () => {
      expect(attributor.getCostBreakdown("no-wf")).toHaveLength(0);
    });

    it("returns one entry per unique agent in the workflow", () => {
      store.insertCostRecord(makeCostRecord({ agent_id: "planner", workflow_id: "wf-1" }));
      store.insertCostRecord(makeCostRecord({ agent_id: "executor", workflow_id: "wf-1" }));
      store.insertCostRecord(makeCostRecord({ agent_id: "planner", workflow_id: "wf-1" }));
      const breakdown = attributor.getCostBreakdown("wf-1");
      expect(breakdown).toHaveLength(2);
      const keys = breakdown.map((e) => e.key);
      expect(keys).toContain("planner");
      expect(keys).toContain("executor");
    });

    it("sets the label as agent:<agent_id>", () => {
      store.insertCostRecord(makeCostRecord({ agent_id: "my-agent", workflow_id: "wf-1" }));
      const breakdown = attributor.getCostBreakdown("wf-1");
      expect(breakdown[0].label).toBe("agent:my-agent");
    });

    it("aggregates total_cost correctly per agent", () => {
      store.insertCostRecord(makeCostRecord({ agent_id: "a1", workflow_id: "wf-1", cost: 0.01 }));
      store.insertCostRecord(makeCostRecord({ agent_id: "a1", workflow_id: "wf-1", cost: 0.02 }));
      store.insertCostRecord(makeCostRecord({ agent_id: "a2", workflow_id: "wf-1", cost: 0.05 }));
      const breakdown = attributor.getCostBreakdown("wf-1");
      const a1 = breakdown.find((e) => e.key === "a1")!;
      expect(a1.total_cost).toBeCloseTo(0.03, 6);
      expect(a1.call_count).toBe(2);
    });

    it("aggregates total_tokens correctly", () => {
      store.insertCostRecord(makeCostRecord({ agent_id: "a1", workflow_id: "wf-1", total_tokens: 400 }));
      store.insertCostRecord(makeCostRecord({ agent_id: "a1", workflow_id: "wf-1", total_tokens: 600 }));
      const breakdown = attributor.getCostBreakdown("wf-1");
      const a1 = breakdown.find((e) => e.key === "a1")!;
      expect(a1.total_tokens).toBe(1000);
    });

    it("computes avg_cost_per_call correctly", () => {
      store.insertCostRecord(makeCostRecord({ agent_id: "a1", workflow_id: "wf-1", cost: 0.01 }));
      store.insertCostRecord(makeCostRecord({ agent_id: "a1", workflow_id: "wf-1", cost: 0.03 }));
      const breakdown = attributor.getCostBreakdown("wf-1");
      const a1 = breakdown.find((e) => e.key === "a1")!;
      expect(a1.avg_cost_per_call).toBeCloseTo(0.02, 6);
    });

    it("sorts entries by total_cost descending", () => {
      store.insertCostRecord(makeCostRecord({ agent_id: "cheap", workflow_id: "wf-1", cost: 0.001 }));
      store.insertCostRecord(makeCostRecord({ agent_id: "expensive", workflow_id: "wf-1", cost: 0.9 }));
      const breakdown = attributor.getCostBreakdown("wf-1");
      expect(breakdown[0].key).toBe("expensive");
      expect(breakdown[1].key).toBe("cheap");
    });
  });

  describe("getCostBreakdownByModel()", () => {
    it("returns empty array when trace has no records", () => {
      expect(attributor.getCostBreakdownByModel("no-trace")).toHaveLength(0);
    });

    it("returns one entry per unique model used in the trace", () => {
      store.insertCostRecord(makeCostRecord({ trace_id: "t1", model: "claude-sonnet-4-6" }));
      store.insertCostRecord(makeCostRecord({ trace_id: "t1", model: "gpt-4o" }));
      const breakdown = attributor.getCostBreakdownByModel("t1");
      expect(breakdown).toHaveLength(2);
    });

    it("sets the label as model:<model_name>", () => {
      store.insertCostRecord(makeCostRecord({ trace_id: "t1", model: "claude-opus-4-6" }));
      const breakdown = attributor.getCostBreakdownByModel("t1");
      expect(breakdown[0].label).toBe("model:claude-opus-4-6");
    });

    it("aggregates costs across multiple calls with same model", () => {
      store.insertCostRecord(makeCostRecord({ trace_id: "t1", model: "gpt-4o", cost: 0.05 }));
      store.insertCostRecord(makeCostRecord({ trace_id: "t1", model: "gpt-4o", cost: 0.05 }));
      const breakdown = attributor.getCostBreakdownByModel("t1");
      expect(breakdown[0].total_cost).toBeCloseTo(0.1, 6);
      expect(breakdown[0].call_count).toBe(2);
    });
  });

  describe("getAgentCostBreakdown()", () => {
    it("returns empty array when agent has no records", () => {
      expect(attributor.getAgentCostBreakdown("nobody")).toHaveLength(0);
    });

    it("groups costs by model for a specific agent", () => {
      store.insertCostRecord(makeCostRecord({ agent_id: "a1", model: "claude-sonnet-4-6", cost: 0.01 }));
      store.insertCostRecord(makeCostRecord({ agent_id: "a1", model: "claude-haiku-4-5", cost: 0.001 }));
      store.insertCostRecord(makeCostRecord({ agent_id: "a1", model: "claude-sonnet-4-6", cost: 0.01 }));
      const breakdown = attributor.getAgentCostBreakdown("a1");
      expect(breakdown).toHaveLength(2);
      const sonnet = breakdown.find((e) => e.key === "claude-sonnet-4-6")!;
      expect(sonnet.call_count).toBe(2);
      expect(sonnet.total_cost).toBeCloseTo(0.02, 6);
    });

    it("does not include records from other agents", () => {
      store.insertCostRecord(makeCostRecord({ agent_id: "a1", model: "gpt-4o", cost: 0.5 }));
      store.insertCostRecord(makeCostRecord({ agent_id: "a2", model: "gpt-4o", cost: 99 }));
      const breakdown = attributor.getAgentCostBreakdown("a1");
      expect(breakdown).toHaveLength(1);
      expect(breakdown[0].total_cost).toBeCloseTo(0.5, 6);
    });
  });
});

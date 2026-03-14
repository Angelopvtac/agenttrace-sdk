/**
 * CostAttributor — Aggregates costs per workflow, agent, tool, and step.
 * Provides cost breakdown reports for attribution and budgeting.
 */

import type { CostRecord, CostBreakdownEntry } from "../types.js";
import { TraceStore } from "../query/trace-store.js";

export class CostAttributor {
  private store: TraceStore;

  constructor(store: TraceStore) {
    this.store = store;
  }

  /**
   * Get total cost for a workflow across all agents and calls.
   */
  getCostByWorkflow(workflowId: string): number {
    const records = this.store.getCostsByWorkflow(workflowId);
    return sum(records.map((r) => r.cost));
  }

  /**
   * Get total cost for an agent across all traces.
   */
  getCostByAgent(agentId: string): number {
    const records = this.store.getCostsByAgent(agentId);
    return sum(records.map((r) => r.cost));
  }

  /**
   * Get a detailed cost breakdown for a workflow, grouped by agent.
   */
  getCostBreakdown(workflowId: string): CostBreakdownEntry[] {
    const records = this.store.getCostsByWorkflow(workflowId);
    return aggregate(records, (r) => r.agent_id, "agent");
  }

  /**
   * Get cost breakdown for a specific trace, grouped by model.
   */
  getCostBreakdownByModel(traceId: string): CostBreakdownEntry[] {
    const records = this.store.getCostsByTrace(traceId);
    return aggregate(records, (r) => r.model, "model");
  }

  /**
   * Get cost breakdown for an agent, grouped by model.
   */
  getAgentCostBreakdown(agentId: string): CostBreakdownEntry[] {
    const records = this.store.getCostsByAgent(agentId);
    return aggregate(records, (r) => r.model, "model");
  }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function aggregate(
  records: CostRecord[],
  keyFn: (r: CostRecord) => string,
  label: string
): CostBreakdownEntry[] {
  const groups = new Map<
    string,
    { totalCost: number; totalTokens: number; callCount: number }
  >();

  for (const r of records) {
    const key = keyFn(r);
    const existing = groups.get(key) ?? {
      totalCost: 0,
      totalTokens: 0,
      callCount: 0,
    };
    existing.totalCost += r.cost;
    existing.totalTokens += r.total_tokens;
    existing.callCount += 1;
    groups.set(key, existing);
  }

  return [...groups.entries()]
    .map(([key, data]) => ({
      key,
      label: `${label}:${key}`,
      total_cost: Math.round(data.totalCost * 1_000_000) / 1_000_000,
      total_tokens: data.totalTokens,
      call_count: data.callCount,
      avg_cost_per_call:
        Math.round((data.totalCost / data.callCount) * 1_000_000) / 1_000_000,
    }))
    .sort((a, b) => b.total_cost - a.total_cost);
}

/**
 * costs command — show cost breakdown by model across all recent traces.
 */

import { TraceStore } from "../../query/trace-store.js";
import { CostAttributor } from "../../cost/cost-attributor.js";
import { renderTable } from "../format/table.js";
import { bold, dim } from "../format/colors.js";

export function runCosts(dbPath: string): void {
  const store = new TraceStore(dbPath);
  const attributor = new CostAttributor(store);

  try {
    const traces = store.listTraces({ limit: 100 });

    if (traces.length === 0) {
      console.log(dim("No traces found."));
      return;
    }

    // Aggregate cost records across all traces by model
    const modelStats = new Map<
      string,
      { calls: number; tokens: number; totalCost: number }
    >();

    for (const trace of traces) {
      const breakdown = attributor.getCostBreakdownByModel(trace.trace_id);
      for (const entry of breakdown) {
        const existing = modelStats.get(entry.key) ?? {
          calls: 0,
          tokens: 0,
          totalCost: 0,
        };
        existing.calls += entry.call_count;
        existing.tokens += entry.total_tokens;
        existing.totalCost += entry.total_cost;
        modelStats.set(entry.key, existing);
      }
    }

    if (modelStats.size === 0) {
      console.log(dim("No cost records found."));
      return;
    }

    console.log(bold(`\nCost Breakdown by Model (${dbPath})\n`));

    const headers = ["Model", "Calls", "Tokens", "Total Cost", "Avg Cost/Call"];
    const rows = [...modelStats.entries()]
      .sort((a, b) => b[1].totalCost - a[1].totalCost)
      .map(([model, stats]) => {
        const avgCost =
          stats.calls > 0 ? stats.totalCost / stats.calls : 0;
        return [
          model,
          String(stats.calls),
          String(stats.tokens),
          `$${stats.totalCost.toFixed(6)}`,
          `$${avgCost.toFixed(6)}`,
        ];
      });

    console.log(renderTable(headers, rows));

    // Grand total
    let grandTotal = 0;
    for (const stats of modelStats.values()) {
      grandTotal += stats.totalCost;
    }
    console.log(dim(`\nGrand total: $${grandTotal.toFixed(6)}`));
  } finally {
    store.close();
  }
}

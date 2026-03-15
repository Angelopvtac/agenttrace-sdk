/**
 * inspect command — list recent traces or drill into a single trace.
 */

import { TraceStore } from "../../query/trace-store.js";
import { renderTable } from "../format/table.js";
import { renderSpanTree } from "../format/tree.js";
import { bold, green, red, yellow, dim } from "../format/colors.js";

function formatStatus(status: string): string {
  switch (status) {
    case "ok":
      return green("ok");
    case "error":
      return red("error");
    case "timeout":
      return yellow("timeout");
    default:
      return status;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0.000000";
  return `$${cost.toFixed(6)}`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

export function runInspect(dbPath: string, traceId?: string): void {
  const store = new TraceStore(dbPath);

  try {
    if (!traceId) {
      // List mode: show recent traces as a summary table
      const traces = store.listTraces({ limit: 20 });

      if (traces.length === 0) {
        console.log(dim("No traces found."));
        return;
      }

      console.log(bold(`\nTraces in ${dbPath}\n`));

      const headers = [
        "ID",
        "Workflow",
        "Status",
        "Spans",
        "Cost ($)",
        "Duration",
        "Agents",
      ];
      const rows = traces.map((t) => [
        t.trace_id.slice(0, 8),
        t.workflow_id ?? "(none)",
        t.status,
        String(t.span_count),
        t.total_cost.toFixed(6),
        formatDuration(t.duration_ms),
        t.agents.join(", ") || "(none)",
      ]);

      console.log(renderTable(headers, rows));
      console.log(dim(`\n${traces.length} trace(s) shown`));
    } else {
      // Detail mode: show trace header + span tree
      const trace = store.getTrace(traceId);

      if (!trace) {
        console.error(red(`Trace not found: ${traceId}`));
        process.exit(1);
      }

      console.log(bold(`\nTrace: ${trace.trace_id}`));
      console.log(`  Workflow:  ${trace.workflow_id ?? "(none)"}`);
      console.log(`  Status:    ${formatStatus(trace.status)}`);
      console.log(`  Started:   ${formatTimestamp(trace.start_time)}`);
      console.log(`  Duration:  ${formatDuration(trace.duration_ms)}`);
      console.log(`  Spans:     ${trace.span_count}`);
      console.log(`  Cost:      ${formatCost(trace.total_cost)}`);
      console.log(`  Tokens:    ${trace.total_tokens}`);
      console.log(`  Agents:    ${trace.agents.join(", ") || "(none)"}`);
      console.log();
      console.log(bold("Span Tree:"));
      console.log();

      const spans = store.getSpans(traceId);
      console.log(renderSpanTree(spans));
      console.log();
    }
  } finally {
    store.close();
  }
}

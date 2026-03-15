/**
 * anomalies command — list anomaly alerts from recent traces.
 */

import { TraceStore } from "../../query/trace-store.js";
import { renderTable } from "../format/table.js";
import { bold, dim, yellow, red } from "../format/colors.js";

function formatSeverity(severity: string): string {
  switch (severity) {
    case "warning":
      return yellow("warning");
    case "critical":
      return red("critical");
    case "info":
      return severity;
    default:
      return severity;
  }
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

export function runAnomalies(dbPath: string): void {
  const store = new TraceStore(dbPath);

  try {
    const traces = store.listTraces({ limit: 100, has_anomaly: true });

    if (traces.length === 0) {
      console.log(dim("No anomalies found."));
      return;
    }

    // Collect all anomalies across recent traces
    const allAnomalies = traces.flatMap((t) =>
      store.getAnomaliesByTrace(t.trace_id)
    );

    // Sort by timestamp descending (most recent first)
    allAnomalies.sort((a, b) => b.timestamp - a.timestamp);

    if (allAnomalies.length === 0) {
      console.log(dim("No anomalies found."));
      return;
    }

    console.log(bold(`\nAnomaly Alerts (${dbPath})\n`));

    const headers = [
      "Time",
      "Type",
      "Severity",
      "Agent",
      "Metric",
      "Expected",
      "Actual",
      "Evidence",
    ];

    const rows = allAnomalies.map((a) => [
      formatTimestamp(a.timestamp),
      a.type,
      a.severity,
      a.agent_id,
      a.metric,
      String(a.expected),
      String(a.actual),
      truncate(a.evidence, 50),
    ]);

    // Render without color in rows (color applied inline via formatSeverity for display)
    // We produce a plain table first, then we need to inject colors separately.
    // Since renderTable works on plain strings and ANSI codes don't affect logic here,
    // we pass formatted severity directly.
    const coloredRows = allAnomalies.map((a) => [
      formatTimestamp(a.timestamp),
      a.type,
      formatSeverity(a.severity),
      a.agent_id,
      a.metric,
      String(a.expected),
      String(a.actual),
      truncate(a.evidence, 50),
    ]);

    // For column width calculation, use uncolored rows so widths are correct
    const plainRows = rows;
    // Build a custom table: calculate widths from plain data, render with colored data
    const colWidths = headers.map((h) => h.length);
    for (const row of plainRows) {
      for (let i = 0; i < row.length; i++) {
        const cell = row[i] ?? "";
        if (cell.length > colWidths[i]!) {
          colWidths[i] = cell.length;
        }
      }
    }

    const headerLine = headers
      .map((h, i) => h.padEnd(colWidths[i]!))
      .join("  ");
    const separator = colWidths.map((w) => "-".repeat(w)).join("  ");

    const dataLines = coloredRows.map((row, rowIdx) => {
      return headers
        .map((_, i) => {
          const cell = row[i] ?? "";
          // For severity column (index 2), don't pad beyond visible width
          // since ANSI codes add invisible chars. Use plain width for padding.
          const plainCell = plainRows[rowIdx]?.[i] ?? "";
          const pad = colWidths[i]! - plainCell.length;
          return cell + " ".repeat(Math.max(0, pad));
        })
        .join("  ");
    });

    console.log(headerLine);
    console.log(separator);
    for (const line of dataLines) {
      console.log(line);
    }

    console.log(dim(`\n${allAnomalies.length} anomaly alert(s) found`));
  } finally {
    store.close();
  }
}

/**
 * Fixed-width table renderer for CLI output.
 * Right-aligns numeric columns (cost, tokens, duration, spans).
 */

/** Column names that should be right-aligned. */
const RIGHT_ALIGN_HEADERS = new Set([
  "Cost ($)",
  "Tokens",
  "Duration",
  "Spans",
  "Calls",
  "Total Cost",
  "Avg Cost/Call",
  "Expected",
  "Actual",
]);

function isNumericHeader(header: string): boolean {
  return RIGHT_ALIGN_HEADERS.has(header);
}

function padCell(value: string, width: number, rightAlign: boolean): string {
  if (rightAlign) {
    return value.padStart(width);
  }
  return value.padEnd(width);
}

/**
 * Render a table with fixed-width columns based on content.
 * Numeric columns (by header name) are right-aligned.
 */
export function renderTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return "";

  // Calculate column widths
  const colWidths: number[] = headers.map((h) => h.length);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i] ?? "";
      if (cell.length > colWidths[i]!) {
        colWidths[i] = cell.length;
      }
    }
  }

  const rightAlign = headers.map((h) => isNumericHeader(h));

  // Build header row
  const headerCells = headers.map((h, i) =>
    padCell(h, colWidths[i]!, rightAlign[i]!)
  );
  const headerRow = headerCells.join("  ");

  // Build separator
  const separator = colWidths.map((w) => "-".repeat(w)).join("  ");

  // Build data rows
  const dataRows = rows.map((row) => {
    const cells = headers.map((_, i) => {
      const cell = row[i] ?? "";
      return padCell(cell, colWidths[i]!, rightAlign[i]!);
    });
    return cells.join("  ");
  });

  const lines = [headerRow, separator, ...dataRows];
  return lines.join("\n");
}

/**
 * Span tree renderer for CLI output.
 * Builds a parent-child tree from flat spans and renders with indent characters.
 */

import type { Span, SpanType, SpanStatus } from "../../types.js";
import { green, red, yellow, cyan, blue, magenta, dim } from "./colors.js";

/** Status icons for span display. */
function statusIcon(status: SpanStatus): string {
  switch (status) {
    case "ok":
      return green("✓");
    case "error":
      return red("✗");
    case "timeout":
      return yellow("⏱");
  }
}

/** Color span name by type. */
function colorName(name: string, type: SpanType): string {
  switch (type) {
    case "agent.llm_call":
      return cyan(name);
    case "agent.tool_call":
      return yellow(name);
    case "agent.message":
      return blue(name);
    case "agent.decision":
      return magenta(name);
    case "agent.workflow":
      return name;
    default:
      return name;
  }
}

interface SpanNode {
  span: Span;
  children: SpanNode[];
}

function buildTree(spans: Span[]): SpanNode[] {
  const nodeMap = new Map<string, SpanNode>();

  // Create all nodes first
  for (const span of spans) {
    nodeMap.set(span.span_id, { span, children: [] });
  }

  const roots: SpanNode[] = [];

  // Wire up parent-child relationships
  for (const span of spans) {
    const node = nodeMap.get(span.span_id)!;
    if (span.parent_span_id !== null && nodeMap.has(span.parent_span_id)) {
      nodeMap.get(span.parent_span_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function formatSpanLine(span: Span): string {
  const icon = statusIcon(span.status);
  const name = colorName(span.name, span.type);
  const durationStr = dim(`${span.duration_ms}ms`);

  const parts: string[] = [durationStr];

  if (span.type === "agent.llm_call" && span.attributes.cost !== undefined) {
    const costStr = dim(`$${span.attributes.cost.toFixed(6)}`);
    parts.push(costStr);
  }

  const meta = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${icon} ${name}${meta}`;
}

function renderNode(
  node: SpanNode,
  prefix: string,
  isLast: boolean,
  lines: string[]
): void {
  const connector = isLast ? "└── " : "├── ";
  lines.push(prefix + connector + formatSpanLine(node.span));

  const childPrefix = prefix + (isLast ? "    " : "│   ");
  for (let i = 0; i < node.children.length; i++) {
    const childIsLast = i === node.children.length - 1;
    renderNode(node.children[i]!, childPrefix, childIsLast, lines);
  }
}

/**
 * Render a flat list of spans as an indented tree using parent_span_id relationships.
 */
export function renderSpanTree(spans: Span[]): string {
  if (spans.length === 0) return "(no spans)";

  const roots = buildTree(spans);
  const lines: string[] = [];

  for (let i = 0; i < roots.length; i++) {
    const isLast = i === roots.length - 1;
    const root = roots[i]!;

    // Root nodes use no prefix connector for the first level
    lines.push(formatSpanLine(root.span));

    const childPrefix = "";
    for (let j = 0; j < root.children.length; j++) {
      const childIsLast = j === root.children.length - 1;
      renderNode(root.children[j]!, childPrefix, childIsLast, lines);
    }

    // Separator between root spans
    if (!isLast) {
      lines.push("");
    }
  }

  return lines.join("\n");
}

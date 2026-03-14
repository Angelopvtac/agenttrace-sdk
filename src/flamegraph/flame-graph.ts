/**
 * FlameGraph — Reconstructs hierarchical execution trees from flat spans.
 *
 * Produces a FlameNode tree suitable for rendering with d3-flame-graph
 * or similar visualization libraries.
 */

import type { Span, FlameNode, SpanType } from "../types.js";
import { TraceStore } from "../query/trace-store.js";

export class FlameGraphBuilder {
  private store: TraceStore;

  constructor(store: TraceStore) {
    this.store = store;
  }

  /**
   * Build a flame graph for a trace.
   * Returns the root FlameNode with all children nested recursively.
   * If the trace has multiple root spans (no parent), they are wrapped
   * in a synthetic root node.
   */
  buildFlameGraph(traceId: string): FlameNode | null {
    const spans = this.store.getSpans(traceId);
    if (spans.length === 0) return null;

    return buildTree(spans);
  }

  /**
   * Export a flame graph as JSON (d3-flame-graph compatible format).
   * The output uses "name", "value" (duration), and "children" keys.
   */
  exportJson(traceId: string): string | null {
    const root = this.buildFlameGraph(traceId);
    if (!root) return null;
    return JSON.stringify(toD3Format(root), null, 2);
  }
}

/**
 * Build a tree from a flat list of spans.
 */
function buildTree(spans: Span[]): FlameNode {
  const nodeMap = new Map<string, FlameNode>();
  const roots: FlameNode[] = [];

  // Create nodes
  for (const span of spans) {
    nodeMap.set(span.span_id, spanToNode(span));
  }

  // Link parent-child relationships
  for (const span of spans) {
    const node = nodeMap.get(span.span_id)!;
    if (span.parent_span_id && nodeMap.has(span.parent_span_id)) {
      nodeMap.get(span.parent_span_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children by start_time at every level
  for (const node of nodeMap.values()) {
    node.children.sort((a, b) => a.start_time - b.start_time);
  }

  if (roots.length === 1) return roots[0];

  // Multiple roots: wrap in a synthetic root
  const minStart = Math.min(...roots.map((r) => r.start_time));
  const maxEnd = Math.max(...roots.map((r) => r.start_time + r.duration));

  return {
    name: "trace",
    type: "agent.workflow" as SpanType,
    span_id: "synthetic-root",
    start_time: minStart,
    duration: maxEnd - minStart,
    cost: roots.reduce((s, r) => s + sumCost(r), 0),
    tokens: roots.reduce((s, r) => s + sumTokens(r), 0),
    status: roots.some((r) => r.status === "error") ? "error" : "ok",
    attributes: {},
    children: roots.sort((a, b) => a.start_time - b.start_time),
  };
}

function spanToNode(span: Span): FlameNode {
  const tokens =
    (span.attributes.prompt_tokens ?? 0) +
    (span.attributes.completion_tokens ?? 0);

  return {
    name: span.name,
    type: span.type,
    span_id: span.span_id,
    start_time: span.start_time,
    duration: span.duration_ms,
    cost: (span.attributes.cost as number) ?? 0,
    tokens,
    status: span.status,
    attributes: span.attributes,
    children: [],
  };
}

function sumCost(node: FlameNode): number {
  return node.cost + node.children.reduce((s, c) => s + sumCost(c), 0);
}

function sumTokens(node: FlameNode): number {
  return node.tokens + node.children.reduce((s, c) => s + sumTokens(c), 0);
}

/** Convert FlameNode to d3-flame-graph compatible format. */
function toD3Format(node: FlameNode): Record<string, unknown> {
  return {
    name: node.name,
    value: node.duration,
    cost: node.cost,
    tokens: node.tokens,
    type: node.type,
    status: node.status,
    span_id: node.span_id,
    children: node.children.map(toD3Format),
  };
}

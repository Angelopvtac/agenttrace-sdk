import { describe, it, expect, beforeEach } from "vitest";
import { TraceStore, FlameGraphBuilder } from "../src/index.js";
import type { Span } from "../src/index.js";

let spanCounter = 0;

function makeSpan(overrides: Partial<Span> = {}): Span {
  spanCounter++;
  return {
    span_id: `span-${spanCounter}`,
    trace_id: "trace-001",
    parent_span_id: null,
    name: `span-${spanCounter}`,
    type: "agent.llm_call",
    status: "ok",
    start_time: spanCounter * 100,
    end_time: spanCounter * 100 + 50,
    duration_ms: 50,
    attributes: {},
    ...overrides,
  };
}

describe("FlameGraphBuilder", () => {
  let store: TraceStore;
  let builder: FlameGraphBuilder;

  beforeEach(() => {
    spanCounter = 0;
    store = new TraceStore(":memory:");
    builder = new FlameGraphBuilder(store);
  });

  describe("buildFlameGraph()", () => {
    it("returns null for an empty trace", () => {
      expect(builder.buildFlameGraph("no-spans-trace")).toBeNull();
    });

    it("returns a single root node for a trace with one span", () => {
      store.insertSpan(makeSpan({ span_id: "s1", name: "root-span", trace_id: "t1" }));
      const root = builder.buildFlameGraph("t1");
      expect(root).not.toBeNull();
      expect(root!.name).toBe("root-span");
      expect(root!.span_id).toBe("s1");
      expect(root!.children).toHaveLength(0);
    });

    it("builds a two-level tree with parent-child relationship", () => {
      store.insertSpan(makeSpan({ span_id: "parent", name: "parent-span", trace_id: "t1" }));
      store.insertSpan(makeSpan({ span_id: "child", name: "child-span", trace_id: "t1", parent_span_id: "parent" }));
      const root = builder.buildFlameGraph("t1");
      expect(root!.span_id).toBe("parent");
      expect(root!.children).toHaveLength(1);
      expect(root!.children[0].span_id).toBe("child");
    });

    it("builds a deep multi-level tree", () => {
      store.insertSpan(makeSpan({ span_id: "s1", name: "level-0", trace_id: "t1" }));
      store.insertSpan(makeSpan({ span_id: "s2", name: "level-1", trace_id: "t1", parent_span_id: "s1" }));
      store.insertSpan(makeSpan({ span_id: "s3", name: "level-2", trace_id: "t1", parent_span_id: "s2" }));
      const root = builder.buildFlameGraph("t1");
      expect(root!.name).toBe("level-0");
      expect(root!.children[0].name).toBe("level-1");
      expect(root!.children[0].children[0].name).toBe("level-2");
    });

    it("wraps multiple roots in a synthetic root node", () => {
      store.insertSpan(makeSpan({ span_id: "r1", name: "root-A", trace_id: "t1", start_time: 100 }));
      store.insertSpan(makeSpan({ span_id: "r2", name: "root-B", trace_id: "t1", start_time: 200 }));
      const root = builder.buildFlameGraph("t1");
      expect(root!.span_id).toBe("synthetic-root");
      expect(root!.name).toBe("trace");
      expect(root!.type).toBe("agent.workflow");
      expect(root!.children).toHaveLength(2);
    });

    it("synthetic root children are sorted by start_time", () => {
      // Insert in reverse order to test sorting
      store.insertSpan(makeSpan({ span_id: "r2", name: "second", trace_id: "t1", start_time: 500, end_time: 600, duration_ms: 100 }));
      store.insertSpan(makeSpan({ span_id: "r1", name: "first", trace_id: "t1", start_time: 100, end_time: 200, duration_ms: 100 }));
      const root = builder.buildFlameGraph("t1");
      expect(root!.children[0].name).toBe("first");
      expect(root!.children[1].name).toBe("second");
    });

    it("sorts children within a node by start_time", () => {
      store.insertSpan(makeSpan({ span_id: "parent", trace_id: "t1", start_time: 0 }));
      store.insertSpan(makeSpan({ span_id: "child-b", trace_id: "t1", parent_span_id: "parent", start_time: 300, end_time: 350, duration_ms: 50 }));
      store.insertSpan(makeSpan({ span_id: "child-a", trace_id: "t1", parent_span_id: "parent", start_time: 100, end_time: 150, duration_ms: 50 }));
      const root = builder.buildFlameGraph("t1");
      expect(root!.children[0].span_id).toBe("child-a");
      expect(root!.children[1].span_id).toBe("child-b");
    });

    it("handles a span with an unknown parent (treats it as root)", () => {
      // parent_span_id references a span not in the trace
      store.insertSpan(makeSpan({ span_id: "orphan", trace_id: "t1", parent_span_id: "missing-parent" }));
      const root = builder.buildFlameGraph("t1");
      // orphan becomes a root since its parent doesn't exist
      expect(root!.span_id).toBe("orphan");
    });

    it("maps FlameNode fields correctly from span data", () => {
      store.insertSpan(makeSpan({
        span_id: "s1",
        trace_id: "t1",
        name: "llm.claude-sonnet-4-6",
        type: "agent.llm_call",
        status: "ok",
        start_time: 1000,
        end_time: 2500,
        duration_ms: 1500,
        attributes: { prompt_tokens: 300, completion_tokens: 200, cost: 0.005 },
      }));
      const root = builder.buildFlameGraph("t1")!;
      expect(root.name).toBe("llm.claude-sonnet-4-6");
      expect(root.type).toBe("agent.llm_call");
      expect(root.status).toBe("ok");
      expect(root.start_time).toBe(1000);
      expect(root.duration).toBe(1500);
      expect(root.tokens).toBe(500);
      expect(root.cost).toBe(0.005);
    });

    it("sets cost to 0 when no cost attribute on span", () => {
      store.insertSpan(makeSpan({ span_id: "s1", trace_id: "t1", attributes: {} }));
      const root = builder.buildFlameGraph("t1")!;
      expect(root.cost).toBe(0);
    });

    it("synthetic root has ok status when all spans are ok", () => {
      store.insertSpan(makeSpan({ span_id: "r1", trace_id: "t1", status: "ok" }));
      store.insertSpan(makeSpan({ span_id: "r2", trace_id: "t1", status: "ok" }));
      const root = builder.buildFlameGraph("t1")!;
      expect(root.status).toBe("ok");
    });

    it("synthetic root has error status when any root span has error", () => {
      store.insertSpan(makeSpan({ span_id: "r1", trace_id: "t1", status: "ok" }));
      store.insertSpan(makeSpan({ span_id: "r2", trace_id: "t1", status: "error" }));
      const root = builder.buildFlameGraph("t1")!;
      expect(root.status).toBe("error");
    });

    it("sums cost and tokens for synthetic root across all root children", () => {
      store.insertSpan(makeSpan({ span_id: "r1", trace_id: "t1", attributes: { cost: 0.01, prompt_tokens: 100, completion_tokens: 50 } }));
      store.insertSpan(makeSpan({ span_id: "r2", trace_id: "t1", attributes: { cost: 0.02, prompt_tokens: 200, completion_tokens: 100 } }));
      const root = builder.buildFlameGraph("t1")!;
      expect(root.cost).toBeCloseTo(0.03, 6);
      expect(root.tokens).toBe(450);
    });
  });

  describe("exportJson()", () => {
    it("returns null for an empty trace", () => {
      expect(builder.exportJson("no-spans-trace")).toBeNull();
    });

    it("returns a valid JSON string", () => {
      store.insertSpan(makeSpan({ span_id: "s1", trace_id: "t1" }));
      const json = builder.exportJson("t1");
      expect(json).not.toBeNull();
      expect(() => JSON.parse(json!)).not.toThrow();
    });

    it("exported JSON contains name, value, and children fields (d3-compatible)", () => {
      store.insertSpan(makeSpan({ span_id: "s1", trace_id: "t1", name: "my-span", duration_ms: 999 }));
      const json = builder.exportJson("t1");
      const parsed = JSON.parse(json!);
      expect(parsed).toHaveProperty("name", "my-span");
      expect(parsed).toHaveProperty("value", 999);
      expect(parsed).toHaveProperty("children");
      expect(Array.isArray(parsed.children)).toBe(true);
    });

    it("exported JSON contains cost, tokens, type, status, and span_id fields", () => {
      store.insertSpan(makeSpan({ span_id: "s1", trace_id: "t1", type: "agent.tool_call", status: "error", attributes: { cost: 0.005 } }));
      const json = builder.exportJson("t1");
      const parsed = JSON.parse(json!);
      expect(parsed).toHaveProperty("cost");
      expect(parsed).toHaveProperty("tokens");
      expect(parsed).toHaveProperty("type", "agent.tool_call");
      expect(parsed).toHaveProperty("status", "error");
      expect(parsed).toHaveProperty("span_id", "s1");
    });

    it("nested children are also in d3 format", () => {
      store.insertSpan(makeSpan({ span_id: "p1", trace_id: "t1", name: "parent" }));
      store.insertSpan(makeSpan({ span_id: "c1", trace_id: "t1", name: "child", parent_span_id: "p1" }));
      const json = builder.exportJson("t1");
      const parsed = JSON.parse(json!);
      expect(parsed.children).toHaveLength(1);
      expect(parsed.children[0]).toHaveProperty("name", "child");
      expect(parsed.children[0]).toHaveProperty("value");
    });
  });
});

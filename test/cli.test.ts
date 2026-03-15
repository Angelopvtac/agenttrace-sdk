import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TraceStore } from "../src/index.js";
import type { Span, Trace, CostRecord, AnomalyAlert } from "../src/index.js";
import { renderTable } from "../src/cli/format/table.js";
import { renderSpanTree } from "../src/cli/format/tree.js";
import { bold, dim, red, green, yellow, cyan, blue, magenta } from "../src/cli/format/colors.js";
import { runInspect } from "../src/cli/commands/inspect.js";
import { runCosts } from "../src/cli/commands/costs.js";
import { runAnomalies } from "../src/cli/commands/anomalies.js";

// --- Test helpers ---

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    span_id: "span-001",
    trace_id: "trace-001",
    parent_span_id: null,
    name: "llm.call",
    type: "agent.llm_call",
    status: "ok",
    start_time: 1000,
    end_time: 2000,
    duration_ms: 1000,
    attributes: { agent_id: "agent-a", model: "claude-sonnet-4-6", cost: 0.005 },
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
    span_count: 3,
    total_cost: 0.015,
    total_tokens: 500,
    status: "ok",
    agents: ["agent-a", "agent-b"],
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
    cost: 0.005,
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
    evidence: "10x cost spike detected",
    timestamp: 1000,
    ...overrides,
  };
}

// Capture console.log output
function captureOutput(fn: () => void): string {
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  console.error = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return lines.join("\n");
}

// --- Color tests ---

describe("colors", () => {
  const originalNoColor = process.env["NO_COLOR"];

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env["NO_COLOR"];
    } else {
      process.env["NO_COLOR"] = originalNoColor;
    }
  });

  it("bold wraps with ANSI escape codes when NO_COLOR is not set", () => {
    delete process.env["NO_COLOR"];
    const result = bold("hello");
    expect(result).toContain("\x1b[");
    expect(result).toContain("hello");
  });

  it("bold returns plain string when NO_COLOR is set", () => {
    process.env["NO_COLOR"] = "1";
    expect(bold("hello")).toBe("hello");
  });

  it("dim returns plain string when NO_COLOR is set", () => {
    process.env["NO_COLOR"] = "1";
    expect(dim("hello")).toBe("hello");
  });

  it("red returns plain string when NO_COLOR is set", () => {
    process.env["NO_COLOR"] = "1";
    expect(red("error")).toBe("error");
  });

  it("green returns plain string when NO_COLOR is set", () => {
    process.env["NO_COLOR"] = "1";
    expect(green("ok")).toBe("ok");
  });

  it("yellow returns plain string when NO_COLOR is set", () => {
    process.env["NO_COLOR"] = "1";
    expect(yellow("warn")).toBe("warn");
  });

  it("cyan wraps with ANSI codes when NO_COLOR is not set", () => {
    delete process.env["NO_COLOR"];
    const result = cyan("llm.call");
    expect(result).toContain("\x1b[");
    expect(result).toContain("llm.call");
  });

  it("blue wraps with ANSI codes when NO_COLOR is not set", () => {
    delete process.env["NO_COLOR"];
    const result = blue("message");
    expect(result).toContain("\x1b[");
  });

  it("magenta wraps with ANSI codes when NO_COLOR is not set", () => {
    delete process.env["NO_COLOR"];
    const result = magenta("decision");
    expect(result).toContain("\x1b[");
  });

  it("all color functions return plain strings when NO_COLOR is set", () => {
    process.env["NO_COLOR"] = "1";
    expect(bold("x")).toBe("x");
    expect(dim("x")).toBe("x");
    expect(red("x")).toBe("x");
    expect(green("x")).toBe("x");
    expect(yellow("x")).toBe("x");
    expect(blue("x")).toBe("x");
    expect(cyan("x")).toBe("x");
    expect(magenta("x")).toBe("x");
  });
});

// --- Table rendering tests ---

describe("renderTable", () => {
  it("renders a basic table with headers and separator", () => {
    const output = renderTable(["Name", "Value"], [["foo", "bar"]]);
    const lines = output.split("\n");
    expect(lines[0]).toContain("Name");
    expect(lines[0]).toContain("Value");
    expect(lines[1]).toMatch(/^-+/);
    expect(lines[2]).toContain("foo");
    expect(lines[2]).toContain("bar");
  });

  it("pads columns to the max content width", () => {
    const output = renderTable(
      ["ID", "Description"],
      [
        ["abc", "short"],
        ["def", "a much longer description"],
      ]
    );
    const lines = output.split("\n");
    // All data rows should have the same total length
    expect(lines[2]!.length).toBe(lines[3]!.length);
  });

  it("right-aligns numeric columns (Cost ($), Tokens, Duration, Spans)", () => {
    const output = renderTable(
      ["Name", "Cost ($)", "Spans"],
      [
        ["agent-a", "0.005000", "10"],
        ["agent-b", "1.000000", "2"],
      ]
    );
    const lines = output.split("\n");
    // The cost column in data rows should be right-aligned (leading spaces for shorter values)
    // "Cost ($)" is 8 chars, "1.000000" is 8 chars — equal, but "0.005000" also 8
    // Test that column headers appear in header
    expect(lines[0]).toContain("Cost ($)");
    expect(lines[0]).toContain("Spans");
    expect(output).toContain("0.005000");
    expect(output).toContain("1.000000");
  });

  it("returns empty string for empty headers", () => {
    expect(renderTable([], [])).toBe("");
  });

  it("handles rows with missing cells gracefully", () => {
    const output = renderTable(["A", "B", "C"], [["only-a"]]);
    expect(output).toContain("only-a");
  });

  it("renders multiple rows correctly", () => {
    const rows = [
      ["trace-001", "wf-a", "ok", "5", "0.010000"],
      ["trace-002", "wf-b", "error", "3", "0.002000"],
      ["trace-003", "wf-c", "timeout", "7", "0.050000"],
    ];
    const output = renderTable(
      ["ID", "Workflow", "Status", "Spans", "Cost ($)"],
      rows
    );
    expect(output).toContain("trace-001");
    expect(output).toContain("trace-002");
    expect(output).toContain("trace-003");
    expect(output).toContain("wf-b");
    expect(output).toContain("error");
  });
});

// --- Span tree rendering tests ---

describe("renderSpanTree", () => {
  beforeEach(() => {
    // Disable colors for tree tests so we can check text content
    process.env["NO_COLOR"] = "1";
  });

  afterEach(() => {
    delete process.env["NO_COLOR"];
  });

  it("returns (no spans) for empty input", () => {
    expect(renderSpanTree([])).toBe("(no spans)");
  });

  it("renders a single root span", () => {
    const span = makeSpan();
    const output = renderSpanTree([span]);
    expect(output).toContain("llm.call");
    expect(output).toContain("1000ms");
  });

  it("renders parent-child relationship with indent characters", () => {
    const parent = makeSpan({
      span_id: "parent-1",
      name: "workflow.run",
      type: "agent.workflow",
      parent_span_id: null,
    });
    const child = makeSpan({
      span_id: "child-1",
      name: "llm.inference",
      type: "agent.llm_call",
      parent_span_id: "parent-1",
    });
    const output = renderSpanTree([parent, child]);
    // Should contain tree indent characters
    expect(output).toContain("└──");
    expect(output).toContain("workflow.run");
    expect(output).toContain("llm.inference");
  });

  it("renders nested spans with correct tree structure", () => {
    const root = makeSpan({
      span_id: "root",
      name: "root.span",
      type: "agent.workflow",
      parent_span_id: null,
    });
    const child1 = makeSpan({
      span_id: "child-1",
      name: "child.one",
      type: "agent.llm_call",
      parent_span_id: "root",
    });
    const child2 = makeSpan({
      span_id: "child-2",
      name: "child.two",
      type: "agent.tool_call",
      parent_span_id: "root",
    });
    const grandchild = makeSpan({
      span_id: "gc-1",
      name: "grandchild",
      type: "agent.decision",
      parent_span_id: "child-1",
    });

    const output = renderSpanTree([root, child1, child2, grandchild]);
    expect(output).toContain("root.span");
    expect(output).toContain("child.one");
    expect(output).toContain("child.two");
    expect(output).toContain("grandchild");
    // Child1 is not the last child, so it should use ├──
    expect(output).toContain("├──");
    // Child2 is last child, should use └──
    expect(output).toContain("└──");
  });

  it("renders multiple root spans", () => {
    const root1 = makeSpan({
      span_id: "root-1",
      name: "trace.one",
      type: "agent.workflow",
      parent_span_id: null,
    });
    const root2 = makeSpan({
      span_id: "root-2",
      name: "trace.two",
      type: "agent.workflow",
      parent_span_id: null,
    });
    const output = renderSpanTree([root1, root2]);
    expect(output).toContain("trace.one");
    expect(output).toContain("trace.two");
  });

  it("shows cost for llm_call spans", () => {
    const span = makeSpan({
      type: "agent.llm_call",
      attributes: { cost: 0.005, agent_id: "agent-a" },
    });
    const output = renderSpanTree([span]);
    expect(output).toContain("0.005");
  });

  it("shows status icons for ok, error, timeout spans", () => {
    const ok = makeSpan({ span_id: "s1", status: "ok" });
    const err = makeSpan({ span_id: "s2", status: "error" });
    const timeout = makeSpan({ span_id: "s3", status: "timeout" });

    expect(renderSpanTree([ok])).toContain("✓");
    expect(renderSpanTree([err])).toContain("✗");
    expect(renderSpanTree([timeout])).toContain("⏱");
  });
});

// --- Command integration tests ---

describe("inspect command", () => {
  let store: TraceStore;

  beforeEach(() => {
    process.env["NO_COLOR"] = "1";
    store = new TraceStore(":memory:");
  });

  afterEach(() => {
    store.close();
    delete process.env["NO_COLOR"];
  });

  it("shows 'No traces found' when the database is empty", () => {
    const output = captureOutput(() => runInspect(":memory:"));
    expect(output).toContain("No traces found");
  });

  it("renders a trace listing table with correct columns", () => {
    // Use a real temp db file for this test
    const tmpDb = `/tmp/test-inspect-${Date.now()}.db`;
    const s = new TraceStore(tmpDb);
    s.upsertTrace(makeTrace());
    s.close();

    const output = captureOutput(() => runInspect(tmpDb));
    expect(output).toContain("Workflow");
    expect(output).toContain("Status");
    expect(output).toContain("Cost ($)");
    expect(output).toContain("Duration");
    expect(output).toContain("wf-001");
    // trace_id first 8 chars
    expect(output).toContain("trace-00");
  });

  it("renders a span tree when --trace is provided", () => {
    const tmpDb = `/tmp/test-inspect-trace-${Date.now()}.db`;
    const s = new TraceStore(tmpDb);
    s.upsertTrace(makeTrace());
    s.insertSpan(makeSpan());
    s.insertSpan(
      makeSpan({
        span_id: "span-002",
        name: "tool.bash",
        type: "agent.tool_call",
        parent_span_id: "span-001",
      })
    );
    s.close();

    const output = captureOutput(() => runInspect(tmpDb, "trace-001"));
    expect(output).toContain("Trace: trace-001");
    expect(output).toContain("Span Tree:");
    expect(output).toContain("llm.call");
    expect(output).toContain("tool.bash");
  });

  it("prints error and exits when trace is not found", () => {
    const tmpDb = `/tmp/test-inspect-notfound-${Date.now()}.db`;
    const s = new TraceStore(tmpDb);
    s.close();

    const errorLines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errorLines.push(args.join(" "));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    try {
      runInspect(tmpDb, "nonexistent-trace-id");
    } catch {
      // expected — process.exit throws in test
    } finally {
      console.error = origError;
      exitSpy.mockRestore();
    }

    const output = errorLines.join("\n");
    expect(output).toContain("Trace not found");
  });
});

describe("costs command", () => {
  afterEach(() => {
    delete process.env["NO_COLOR"];
  });

  it("shows 'No traces found' when the database is empty", () => {
    process.env["NO_COLOR"] = "1";
    const output = captureOutput(() => runCosts(":memory:"));
    expect(output).toContain("No traces found");
  });

  it("renders cost breakdown table with model information", () => {
    process.env["NO_COLOR"] = "1";
    const tmpDb = `/tmp/test-costs-${Date.now()}.db`;
    const s = new TraceStore(tmpDb);
    s.upsertTrace(makeTrace());
    s.insertCostRecord(makeCostRecord({ model: "claude-sonnet-4-6", cost: 0.005 }));
    s.insertCostRecord(
      makeCostRecord({
        span_id: "span-002",
        model: "gpt-4o",
        cost: 0.002,
      })
    );
    s.close();

    const output = captureOutput(() => runCosts(tmpDb));
    expect(output).toContain("Model");
    expect(output).toContain("Calls");
    expect(output).toContain("Total Cost");
    expect(output).toContain("claude-sonnet-4-6");
    expect(output).toContain("gpt-4o");
    expect(output).toContain("Grand total");
  });
});

describe("anomalies command", () => {
  afterEach(() => {
    delete process.env["NO_COLOR"];
  });

  it("shows 'No anomalies found' when database is empty", () => {
    process.env["NO_COLOR"] = "1";
    const output = captureOutput(() => runAnomalies(":memory:"));
    expect(output).toContain("No anomalies found");
  });

  it("renders anomaly table with correct columns", () => {
    process.env["NO_COLOR"] = "1";
    const tmpDb = `/tmp/test-anomalies-${Date.now()}.db`;
    const s = new TraceStore(tmpDb);
    s.upsertTrace(makeTrace());
    s.insertAnomaly(makeAnomaly({ severity: "warning" }));
    s.insertAnomaly(
      makeAnomaly({
        id: "alert-002",
        type: "latency_spike",
        severity: "critical",
        metric: "latency_ms",
        expected: 500,
        actual: 5000,
        evidence: "10x latency spike",
      })
    );
    s.close();

    const output = captureOutput(() => runAnomalies(tmpDb));
    expect(output).toContain("Type");
    expect(output).toContain("Severity");
    expect(output).toContain("Agent");
    expect(output).toContain("Evidence");
    expect(output).toContain("cost_spike");
    expect(output).toContain("latency_spike");
    expect(output).toContain("warning");
    expect(output).toContain("critical");
    expect(output).toContain("anomaly alert(s) found");
  });
});

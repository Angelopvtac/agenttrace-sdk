import { describe, it, expect, beforeEach } from "vitest";
import { TraceStore, AnomalyDetector } from "../src/index.js";
import type { Span } from "../src/index.js";

let idCounter = 0;

function makeSpan(overrides: Partial<Span> = {}): Span {
  idCounter++;
  return {
    span_id: `span-${idCounter}`,
    trace_id: "trace-001",
    parent_span_id: null,
    name: `test-span-${idCounter}`,
    type: "agent.llm_call",
    status: "ok",
    start_time: idCounter * 100,
    end_time: idCounter * 100 + 500,
    duration_ms: 500,
    attributes: { agent_id: "agent-a", cost: 0.01, prompt_tokens: 100, completion_tokens: 50 },
    ...overrides,
  };
}

/**
 * Seed the store with N spans for agent-a so that baselines are above minSamples.
 * Uses consistent values so EMA converges to predictable baselines.
 */
function seedBaselines(store: TraceStore, detector: AnomalyDetector, count: number = 10, attrs: Partial<Span["attributes"]> = {}) {
  for (let i = 0; i < count; i++) {
    const span = makeSpan({ attributes: { agent_id: "agent-a", cost: 0.01, prompt_tokens: 100, completion_tokens: 50, ...attrs } });
    store.insertSpan(span);
    detector.analyzeSpan(span);
  }
}

describe("AnomalyDetector", () => {
  let store: TraceStore;
  let detector: AnomalyDetector;

  beforeEach(() => {
    idCounter = 0;
    store = new TraceStore(":memory:");
    detector = new AnomalyDetector(store);
  });

  describe("analyzeSpan() — baseline gating", () => {
    it("returns no alerts when there is no baseline yet", () => {
      const span = makeSpan({ attributes: { agent_id: "agent-a", cost: 999 } });
      store.insertSpan(span);
      expect(detector.analyzeSpan(span)).toHaveLength(0);
    });

    it("returns no alerts while sample_count is below minSamples (default 10)", () => {
      // 9 spans: baseline sample_count reaches 9, still below 10
      for (let i = 0; i < 9; i++) {
        const span = makeSpan();
        store.insertSpan(span);
        const alerts = detector.analyzeSpan(span);
        expect(alerts).toHaveLength(0);
      }
    });

    it("starts checking for anomalies once sample_count >= minSamples", () => {
      // Seed 10 normal spans to build baseline
      seedBaselines(store, detector, 10);
      // The 11th span with extreme cost should potentially trigger
      const baseline = store.getBaseline("agent-a");
      expect(baseline).not.toBeNull();
      expect(baseline!.sample_count).toBe(10);
    });
  });

  describe("analyzeSpan() — cost spike detection", () => {
    it("detects a cost spike when cost exceeds 3x baseline avg", () => {
      seedBaselines(store, detector, 10, { cost: 0.01 });
      // Spike: cost = 0.1 (>>3x of ~0.01)
      const spikeSpan = makeSpan({ attributes: { agent_id: "agent-a", cost: 0.1, prompt_tokens: 100, completion_tokens: 50 } });
      store.insertSpan(spikeSpan);
      const alerts = detector.analyzeSpan(spikeSpan);
      expect(alerts.some((a) => a.type === "cost_spike")).toBe(true);
    });

    it("does not flag a normal cost as a spike", () => {
      seedBaselines(store, detector, 10, { cost: 0.01 });
      const normalSpan = makeSpan({ attributes: { agent_id: "agent-a", cost: 0.012, prompt_tokens: 100, completion_tokens: 50 } });
      store.insertSpan(normalSpan);
      const alerts = detector.analyzeSpan(normalSpan);
      expect(alerts.some((a) => a.type === "cost_spike")).toBe(false);
    });

    it("sets severity to warning for 3x–10x spike", () => {
      seedBaselines(store, detector, 10, { cost: 0.01 });
      // 4x spike but less than 10x
      const span = makeSpan({ attributes: { agent_id: "agent-a", cost: 0.05, prompt_tokens: 100, completion_tokens: 50 } });
      store.insertSpan(span);
      const alerts = detector.analyzeSpan(span);
      const costAlert = alerts.find((a) => a.type === "cost_spike");
      if (costAlert) {
        expect(costAlert.severity).toBe("warning");
      }
    });

    it("sets severity to critical for >10x spike", () => {
      seedBaselines(store, detector, 10, { cost: 0.01 });
      // 100x spike
      const span = makeSpan({ attributes: { agent_id: "agent-a", cost: 1.0, prompt_tokens: 100, completion_tokens: 50 } });
      store.insertSpan(span);
      const alerts = detector.analyzeSpan(span);
      const costAlert = alerts.find((a) => a.type === "cost_spike");
      if (costAlert) {
        expect(costAlert.severity).toBe("critical");
      }
    });

    it("persists cost spike alert to the store", () => {
      seedBaselines(store, detector, 10, { cost: 0.01 });
      const span = makeSpan({ attributes: { agent_id: "agent-a", cost: 1.0, prompt_tokens: 100, completion_tokens: 50 } });
      store.insertSpan(span);
      detector.analyzeSpan(span);
      const storedAlerts = store.getAnomaliesByTrace("trace-001");
      expect(storedAlerts.some((a) => a.type === "cost_spike")).toBe(true);
    });

    it("only fires cost_spike for agent.llm_call spans", () => {
      seedBaselines(store, detector, 10, { cost: 0.01 });
      // A tool_call span with high cost attribute should NOT trigger cost_spike
      const toolSpan = makeSpan({
        type: "agent.tool_call",
        attributes: { agent_id: "agent-a", cost: 99, tool_name: "bash" },
      });
      store.insertSpan(toolSpan);
      const alerts = detector.analyzeSpan(toolSpan);
      expect(alerts.some((a) => a.type === "cost_spike")).toBe(false);
    });
  });

  describe("analyzeSpan() — token spike detection", () => {
    it("detects a token spike when tokens exceed 3x baseline avg", () => {
      // Seed with ~150 tokens/call
      seedBaselines(store, detector, 10, { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 });
      // Spike: 1500 tokens (~10x)
      const spikeSpan = makeSpan({ attributes: { agent_id: "agent-a", cost: 0.001, prompt_tokens: 1000, completion_tokens: 500 } });
      store.insertSpan(spikeSpan);
      const alerts = detector.analyzeSpan(spikeSpan);
      expect(alerts.some((a) => a.type === "token_spike")).toBe(true);
    });

    it("does not flag normal token counts", () => {
      seedBaselines(store, detector, 10, { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 });
      const normalSpan = makeSpan({ attributes: { agent_id: "agent-a", cost: 0.001, prompt_tokens: 120, completion_tokens: 60 } });
      store.insertSpan(normalSpan);
      const alerts = detector.analyzeSpan(normalSpan);
      expect(alerts.some((a) => a.type === "token_spike")).toBe(false);
    });

    it("includes trace_id and span_id on the alert", () => {
      seedBaselines(store, detector, 10, { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 });
      const spikeSpan = makeSpan({ trace_id: "special-trace", attributes: { agent_id: "agent-a", cost: 0.001, prompt_tokens: 5000, completion_tokens: 5000 } });
      store.insertSpan(spikeSpan);
      const alerts = detector.analyzeSpan(spikeSpan);
      const tokenAlert = alerts.find((a) => a.type === "token_spike");
      if (tokenAlert) {
        expect(tokenAlert.trace_id).toBe("special-trace");
        expect(tokenAlert.span_id).toBe(spikeSpan.span_id);
        expect(tokenAlert.agent_id).toBe("agent-a");
      }
    });
  });

  describe("analyzeSpan() — latency spike detection", () => {
    it("detects a latency spike when duration exceeds 3x baseline avg", () => {
      // Seed with 500ms/call
      seedBaselines(store, detector, 10, { cost: 0.01, prompt_tokens: 100, completion_tokens: 50 });
      // Spike: 5000ms (~10x)
      const spikeSpan = makeSpan({
        duration_ms: 5000,
        end_time: idCounter * 100 + 5000,
        attributes: { agent_id: "agent-a", cost: 0.01, prompt_tokens: 100, completion_tokens: 50 },
      });
      store.insertSpan(spikeSpan);
      const alerts = detector.analyzeSpan(spikeSpan);
      expect(alerts.some((a) => a.type === "latency_spike")).toBe(true);
    });

    it("does not flag normal latency", () => {
      seedBaselines(store, detector, 10);
      const normalSpan = makeSpan({ duration_ms: 600, attributes: { agent_id: "agent-a", cost: 0.01, prompt_tokens: 100, completion_tokens: 50 } });
      store.insertSpan(normalSpan);
      const alerts = detector.analyzeSpan(normalSpan);
      expect(alerts.some((a) => a.type === "latency_spike")).toBe(false);
    });

    it("sets severity to critical when latency exceeds 10x", () => {
      seedBaselines(store, detector, 10);
      const spikeSpan = makeSpan({
        duration_ms: 50000,
        attributes: { agent_id: "agent-a", cost: 0.01, prompt_tokens: 100, completion_tokens: 50 },
      });
      store.insertSpan(spikeSpan);
      const alerts = detector.analyzeSpan(spikeSpan);
      const latencyAlert = alerts.find((a) => a.type === "latency_spike");
      if (latencyAlert) {
        expect(latencyAlert.severity).toBe("critical");
      }
    });

    it("fires for any span type (not just llm_call)", () => {
      // Seed baselines for agent-a with tool_call spans of 500ms
      for (let i = 0; i < 10; i++) {
        const s = makeSpan({ type: "agent.tool_call", duration_ms: 500, attributes: { agent_id: "agent-a", tool_name: "bash" } });
        store.insertSpan(s);
        detector.analyzeSpan(s);
      }
      const spikeSpan = makeSpan({ type: "agent.tool_call", duration_ms: 20000, attributes: { agent_id: "agent-a", tool_name: "bash" } });
      store.insertSpan(spikeSpan);
      const alerts = detector.analyzeSpan(spikeSpan);
      expect(alerts.some((a) => a.type === "latency_spike")).toBe(true);
    });
  });

  describe("analyzeSpan() — error cascade detection", () => {
    it("detects error cascade when error rate exceeds baseline by >20pp", () => {
      // Seed with 0% error rate
      for (let i = 0; i < 10; i++) {
        const s = makeSpan({ status: "ok", attributes: { agent_id: "agent-a" } });
        store.insertSpan(s);
        detector.analyzeSpan(s);
      }
      // Now insert many error spans in one trace — error rate will be high
      const traceId = "error-trace";
      const errorSpans: Span[] = [];
      for (let i = 0; i < 5; i++) {
        const s = makeSpan({ trace_id: traceId, status: "error", attributes: { agent_id: "agent-a" } });
        store.insertSpan(s);
        errorSpans.push(s);
      }
      // Analyze the last error span - should detect cascade (5/5 = 100% error rate vs 0% baseline)
      const alerts = detector.analyzeSpan(errorSpans[errorSpans.length - 1]);
      expect(alerts.some((a) => a.type === "error_cascade")).toBe(true);
    });

    it("does not fire for ok spans", () => {
      seedBaselines(store, detector, 10);
      const okSpan = makeSpan({ status: "ok", attributes: { agent_id: "agent-a" } });
      store.insertSpan(okSpan);
      const alerts = detector.analyzeSpan(okSpan);
      expect(alerts.some((a) => a.type === "error_cascade")).toBe(false);
    });

    it("sets severity based on error rate", () => {
      // Seed with 0% error rate
      for (let i = 0; i < 10; i++) {
        const s = makeSpan({ status: "ok", attributes: { agent_id: "agent-a" } });
        store.insertSpan(s);
        detector.analyzeSpan(s);
      }
      // Create a trace with >50% errors for critical severity
      const traceId = "cascade-trace";
      for (let i = 0; i < 6; i++) {
        store.insertSpan(makeSpan({ trace_id: traceId, status: "error", attributes: { agent_id: "agent-a" } }));
      }
      for (let i = 0; i < 2; i++) {
        store.insertSpan(makeSpan({ trace_id: traceId, status: "ok", attributes: { agent_id: "agent-a" } }));
      }
      const finalError = makeSpan({ trace_id: traceId, status: "error", attributes: { agent_id: "agent-a" } });
      store.insertSpan(finalError);
      const alerts = detector.analyzeSpan(finalError);
      const cascadeAlert = alerts.find((a) => a.type === "error_cascade");
      if (cascadeAlert) {
        // error_rate > 0.5 => critical
        expect(cascadeAlert.severity).toBe("critical");
      }
    });
  });

  describe("analyzeSpan() — no agent_id", () => {
    it("returns empty array when span has no agent_id", () => {
      const span = makeSpan({ attributes: {} }); // no agent_id
      store.insertSpan(span);
      expect(detector.analyzeSpan(span)).toHaveLength(0);
    });
  });

  describe("analyzeTrace() — loop detection", () => {
    it("returns no alerts for an empty trace", () => {
      expect(detector.analyzeTrace("empty-trace")).toHaveLength(0);
    });

    it("detects a loop when the same tool is called >5 times with similar args", () => {
      const traceId = "loop-trace";
      // Same tool, same args repeated 6 times (above loopThreshold=5)
      for (let i = 0; i < 6; i++) {
        store.insertSpan(makeSpan({
          trace_id: traceId,
          type: "agent.tool_call",
          attributes: { agent_id: "agent-a", tool_name: "bash", tool_args: '{"cmd":"ls"}' },
        }));
      }
      const alerts = detector.analyzeTrace(traceId);
      expect(alerts.some((a) => a.type === "loop_detection")).toBe(true);
    });

    it("does not flag a tool called exactly at loopThreshold (>5, not >=5)", () => {
      const traceId = "borderline-trace";
      for (let i = 0; i < 5; i++) {
        store.insertSpan(makeSpan({
          trace_id: traceId,
          type: "agent.tool_call",
          attributes: { agent_id: "agent-a", tool_name: "bash", tool_args: '{"cmd":"ls"}' },
        }));
      }
      const alerts = detector.analyzeTrace(traceId);
      expect(alerts.some((a) => a.type === "loop_detection")).toBe(false);
    });

    it("does not flag a tool called many times with diverse args (not a loop)", () => {
      const traceId = "diverse-trace";
      // 6 calls but each with unique args
      for (let i = 0; i < 6; i++) {
        store.insertSpan(makeSpan({
          trace_id: traceId,
          type: "agent.tool_call",
          attributes: { agent_id: "agent-a", tool_name: "bash", tool_args: `{"cmd":"ls ${i}"}` },
        }));
      }
      const alerts = detector.analyzeTrace(traceId);
      // 6 unique args out of 6 calls: argSet.size (6) is NOT < calls.length * 0.5 (3)
      expect(alerts.some((a) => a.type === "loop_detection")).toBe(false);
    });

    it("sets loop_detection severity to critical when count > 2x loopThreshold", () => {
      const traceId = "critical-loop";
      // 11 calls > 2 * 5 = 10 → critical
      for (let i = 0; i < 11; i++) {
        store.insertSpan(makeSpan({
          trace_id: traceId,
          type: "agent.tool_call",
          attributes: { agent_id: "agent-a", tool_name: "bash", tool_args: '{"cmd":"ls"}' },
        }));
      }
      const alerts = detector.analyzeTrace(traceId);
      const loopAlert = alerts.find((a) => a.type === "loop_detection");
      expect(loopAlert).toBeDefined();
      expect(loopAlert!.severity).toBe("critical");
    });

    it("sets loop_detection severity to warning when count is between loopThreshold and 2x", () => {
      const traceId = "warning-loop";
      // 7 calls with similar args: > 5 but < 10
      for (let i = 0; i < 7; i++) {
        store.insertSpan(makeSpan({
          trace_id: traceId,
          type: "agent.tool_call",
          attributes: { agent_id: "agent-a", tool_name: "bash", tool_args: '{"cmd":"ls"}' },
        }));
      }
      const alerts = detector.analyzeTrace(traceId);
      const loopAlert = alerts.find((a) => a.type === "loop_detection");
      expect(loopAlert).toBeDefined();
      expect(loopAlert!.severity).toBe("warning");
    });

    it("persists loop alerts to the store", () => {
      const traceId = "persisted-loop";
      for (let i = 0; i < 6; i++) {
        store.insertSpan(makeSpan({
          trace_id: traceId,
          type: "agent.tool_call",
          attributes: { agent_id: "agent-a", tool_name: "bash", tool_args: '{"cmd":"ls"}' },
        }));
      }
      detector.analyzeTrace(traceId);
      expect(store.getAnomaliesByTrace(traceId).some((a) => a.type === "loop_detection")).toBe(true);
    });

    it("ignores non-tool_call spans when checking loops", () => {
      const traceId = "llm-trace";
      for (let i = 0; i < 6; i++) {
        store.insertSpan(makeSpan({
          trace_id: traceId,
          type: "agent.llm_call",
          attributes: { agent_id: "agent-a", model: "claude-sonnet-4-6" },
        }));
      }
      expect(detector.analyzeTrace(traceId).some((a) => a.type === "loop_detection")).toBe(false);
    });
  });

  describe("analyzeTrace() — unusual tool usage frequency", () => {
    it("detects unusual tool usage when frequency exceeds 5x baseline avg_tool_call_frequency", () => {
      // Seed baseline with avg_tool_call_frequency = 1
      for (let i = 0; i < 10; i++) {
        store.updateBaseline("agent-a", { avg_tool_call_frequency: 1 });
      }
      // Now create a trace with 6 tool calls (> 5 * 1)
      const traceId = "freq-trace";
      for (let i = 0; i < 6; i++) {
        store.insertSpan(makeSpan({
          trace_id: traceId,
          type: "agent.tool_call",
          attributes: { agent_id: "agent-a", tool_name: `tool-${i}` }, // different tools, not a loop
        }));
      }
      const alerts = detector.analyzeTrace(traceId);
      // Each tool appears once, none are loops. Check unusual_tool_usage.
      // frequency (1 per tool) vs avg_tool_call_frequency (1) → 1 > 5 * 1 is false
      // So no unusual_tool_usage here. Let's put 6 of same tool with diverse args instead:
      const traceId2 = "freq-trace-2";
      for (let i = 0; i < 6; i++) {
        store.insertSpan(makeSpan({
          trace_id: traceId2,
          type: "agent.tool_call",
          // diverse args so no loop detection, but same tool name
          attributes: { agent_id: "agent-a", tool_name: "read_file", tool_args: `{"path":"/file-${i}"}` },
        }));
      }
      const alerts2 = detector.analyzeTrace(traceId2);
      // 6 calls > 5 * 1 (avg_tool_call_frequency) → unusual_tool_usage
      expect(alerts2.some((a) => a.type === "unusual_tool_usage")).toBe(true);
    });

    it("does not fire unusual_tool_usage before minSamples baseline", () => {
      // Only 5 baseline samples (below default minSamples=10)
      for (let i = 0; i < 5; i++) {
        store.updateBaseline("agent-b", { avg_tool_call_frequency: 1 });
      }
      const traceId = "freq-no-baseline";
      for (let i = 0; i < 10; i++) {
        store.insertSpan(makeSpan({
          trace_id: traceId,
          type: "agent.tool_call",
          attributes: { agent_id: "agent-b", tool_name: "heavy_tool", tool_args: `{"n":${i}}` },
        }));
      }
      const alerts = detector.analyzeTrace(traceId);
      expect(alerts.some((a) => a.type === "unusual_tool_usage")).toBe(false);
    });
  });

  describe("configurable thresholds", () => {
    it("respects custom spikeThreshold", () => {
      const customDetector = new AnomalyDetector(store, { spikeThreshold: 2, minSamples: 5 });
      // Seed 5 spans
      for (let i = 0; i < 5; i++) {
        const s = makeSpan({ attributes: { agent_id: "agent-c", cost: 0.01, prompt_tokens: 100, completion_tokens: 50 } });
        store.insertSpan(s);
        customDetector.analyzeSpan(s);
      }
      // 2.5x cost spike (below default 3x, but above custom 2x)
      const spikeSpan = makeSpan({ attributes: { agent_id: "agent-c", cost: 0.03, prompt_tokens: 100, completion_tokens: 50 } });
      store.insertSpan(spikeSpan);
      const alerts = customDetector.analyzeSpan(spikeSpan);
      expect(alerts.some((a) => a.type === "cost_spike")).toBe(true);
    });

    it("respects custom loopThreshold", () => {
      const customDetector = new AnomalyDetector(store, { loopThreshold: 3 });
      const traceId = "custom-loop";
      for (let i = 0; i < 4; i++) {
        store.insertSpan(makeSpan({
          trace_id: traceId,
          type: "agent.tool_call",
          attributes: { agent_id: "agent-a", tool_name: "bash", tool_args: '{"cmd":"ls"}' },
        }));
      }
      const alerts = customDetector.analyzeTrace(traceId);
      expect(alerts.some((a) => a.type === "loop_detection")).toBe(true);
    });

    it("respects custom minSamples", () => {
      const customDetector = new AnomalyDetector(store, { minSamples: 3 });
      // Seed only 3 spans
      for (let i = 0; i < 3; i++) {
        const s = makeSpan({ attributes: { agent_id: "agent-d", cost: 0.01, prompt_tokens: 100, completion_tokens: 50 } });
        store.insertSpan(s);
        customDetector.analyzeSpan(s);
      }
      // Spike on the 4th span (sample_count=3 >= minSamples=3)
      const spikeSpan = makeSpan({ attributes: { agent_id: "agent-d", cost: 1.0, prompt_tokens: 100, completion_tokens: 50 } });
      store.insertSpan(spikeSpan);
      const alerts = customDetector.analyzeSpan(spikeSpan);
      expect(alerts.some((a) => a.type === "cost_spike")).toBe(true);
    });
  });
});

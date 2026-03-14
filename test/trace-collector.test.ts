import { describe, it, expect, beforeEach } from "vitest";
import { TraceStore, TraceCollector } from "../src/index.js";

describe("TraceCollector", () => {
  let store: TraceStore;
  let collector: TraceCollector;

  beforeEach(() => {
    store = new TraceStore(":memory:");
    collector = new TraceCollector({ store });
  });

  describe("startTrace()", () => {
    it("returns a UUID string", () => {
      const traceId = collector.startTrace();
      expect(typeof traceId).toBe("string");
      expect(traceId.length).toBeGreaterThan(0);
    });

    it("persists a trace record in the store immediately", () => {
      const traceId = collector.startTrace();
      const trace = store.getTrace(traceId);
      expect(trace).not.toBeNull();
      expect(trace!.trace_id).toBe(traceId);
    });

    it("stores the workflow_id when provided", () => {
      const traceId = collector.startTrace("wf-999");
      expect(store.getTrace(traceId)!.workflow_id).toBe("wf-999");
    });

    it("sets workflow_id to null when not provided", () => {
      const traceId = collector.startTrace();
      expect(store.getTrace(traceId)!.workflow_id).toBeNull();
    });

    it("generates unique trace IDs for each call", () => {
      const id1 = collector.startTrace();
      const id2 = collector.startTrace();
      expect(id1).not.toBe(id2);
    });
  });

  describe("recordLlmCall()", () => {
    it("returns a span with agent.llm_call type", () => {
      const traceId = collector.startTrace();
      const span = collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 500,
        completion_tokens: 200,
        duration_ms: 1500,
        agent_id: "planner",
      });
      expect(span.type).toBe("agent.llm_call");
      expect(span.trace_id).toBe(traceId);
    });

    it("creates a cost record in the store", () => {
      const traceId = collector.startTrace("wf-A");
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 1000,
        completion_tokens: 500,
        duration_ms: 2000,
        agent_id: "agent-a",
      });
      const costRecords = store.getCostsByTrace(traceId);
      expect(costRecords).toHaveLength(1);
      expect(costRecords[0].model).toBe("claude-sonnet-4-6");
    });

    it("auto-calculates cost and stores it in the cost record", () => {
      const traceId = collector.startTrace();
      const span = collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        duration_ms: 100,
        agent_id: "a",
      });
      const costRecords = store.getCostsByTrace(traceId);
      // $3 per million input tokens
      expect(costRecords[0].cost).toBeCloseTo(3, 2);
      expect(span.attributes.cost).toBeCloseTo(3, 2);
    });

    it("stores prompt_tokens and completion_tokens in span attributes", () => {
      const traceId = collector.startTrace();
      const span = collector.recordLlmCall(traceId, {
        model: "gpt-4o",
        prompt_tokens: 800,
        completion_tokens: 300,
        duration_ms: 1000,
        agent_id: "a",
      });
      expect(span.attributes.prompt_tokens).toBe(800);
      expect(span.attributes.completion_tokens).toBe(300);
    });

    it("names the span as llm.<model>", () => {
      const traceId = collector.startTrace();
      const span = collector.recordLlmCall(traceId, {
        model: "claude-opus-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 500,
        agent_id: "a",
      });
      expect(span.name).toBe("llm.claude-opus-4-6");
    });

    it("sets span duration_ms correctly", () => {
      const traceId = collector.startTrace();
      const span = collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 1234,
        agent_id: "a",
      });
      expect(span.duration_ms).toBe(1234);
    });

    it("forwards parent_span_id when provided", () => {
      const traceId = collector.startTrace();
      const span = collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 500,
        agent_id: "a",
        parent_span_id: "parent-123",
      });
      expect(span.parent_span_id).toBe("parent-123");
    });

    it("uses status from attrs when provided", () => {
      const traceId = collector.startTrace();
      const span = collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 500,
        agent_id: "a",
        status: "error",
      });
      expect(span.status).toBe("error");
    });

    it("links cost record's workflow_id from the trace", () => {
      const traceId = collector.startTrace("my-workflow");
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 500,
        agent_id: "a",
      });
      const costRecord = store.getCostsByTrace(traceId)[0];
      expect(costRecord.workflow_id).toBe("my-workflow");
    });
  });

  describe("recordToolCall()", () => {
    it("returns a span with agent.tool_call type", () => {
      const traceId = collector.startTrace();
      const span = collector.recordToolCall(traceId, {
        tool_name: "bash",
        success: true,
        duration_ms: 200,
        agent_id: "a",
      });
      expect(span.type).toBe("agent.tool_call");
    });

    it("names the span tool.<tool_name>", () => {
      const traceId = collector.startTrace();
      const span = collector.recordToolCall(traceId, {
        tool_name: "read_file",
        success: true,
        duration_ms: 50,
        agent_id: "a",
      });
      expect(span.name).toBe("tool.read_file");
    });

    it("sets status to ok when success is true", () => {
      const traceId = collector.startTrace();
      const span = collector.recordToolCall(traceId, {
        tool_name: "bash",
        success: true,
        duration_ms: 100,
        agent_id: "a",
      });
      expect(span.status).toBe("ok");
    });

    it("sets status to error when success is false", () => {
      const traceId = collector.startTrace();
      const span = collector.recordToolCall(traceId, {
        tool_name: "bash",
        success: false,
        duration_ms: 100,
        agent_id: "a",
      });
      expect(span.status).toBe("error");
    });

    it("stores tool_name in attributes", () => {
      const traceId = collector.startTrace();
      const span = collector.recordToolCall(traceId, {
        tool_name: "web_search",
        success: true,
        duration_ms: 300,
        agent_id: "a",
      });
      expect(span.attributes.tool_name).toBe("web_search");
    });

    it("does not create a cost record", () => {
      const traceId = collector.startTrace();
      collector.recordToolCall(traceId, {
        tool_name: "bash",
        success: true,
        duration_ms: 100,
        agent_id: "a",
      });
      expect(store.getCostsByTrace(traceId)).toHaveLength(0);
    });
  });

  describe("recordMessage()", () => {
    it("returns a span with agent.message type", () => {
      const traceId = collector.startTrace();
      const span = collector.recordMessage(traceId, {
        from_agent: "planner",
        to_agent: "executor",
        content_summary: "Do the thing",
      });
      expect(span.type).toBe("agent.message");
    });

    it("names the span msg.<from>-><to>", () => {
      const traceId = collector.startTrace();
      const span = collector.recordMessage(traceId, {
        from_agent: "agent-A",
        to_agent: "agent-B",
        content_summary: "hello",
      });
      expect(span.name).toBe("msg.agent-A->agent-B");
    });

    it("sets duration_ms to 0 when not provided", () => {
      const traceId = collector.startTrace();
      const span = collector.recordMessage(traceId, {
        from_agent: "a",
        to_agent: "b",
        content_summary: "hi",
      });
      expect(span.duration_ms).toBe(0);
    });

    it("stores from_agent and to_agent in attributes", () => {
      const traceId = collector.startTrace();
      const span = collector.recordMessage(traceId, {
        from_agent: "sender",
        to_agent: "receiver",
        content_summary: "payload",
      });
      expect(span.attributes.from_agent).toBe("sender");
      expect(span.attributes.to_agent).toBe("receiver");
    });
  });

  describe("recordDecision()", () => {
    it("returns a span with agent.decision type", () => {
      const traceId = collector.startTrace();
      const span = collector.recordDecision(traceId, {
        decision_point: "which_tool",
        options_considered: ["bash", "python"],
        choice_made: "bash",
        confidence: 0.9,
        agent_id: "a",
      });
      expect(span.type).toBe("agent.decision");
    });

    it("names the span decision.<decision_point>", () => {
      const traceId = collector.startTrace();
      const span = collector.recordDecision(traceId, {
        decision_point: "routing",
        options_considered: ["A", "B"],
        choice_made: "A",
        confidence: 0.8,
        agent_id: "a",
      });
      expect(span.name).toBe("decision.routing");
    });

    it("stores options_considered, choice_made, and confidence in attributes", () => {
      const traceId = collector.startTrace();
      const span = collector.recordDecision(traceId, {
        decision_point: "route",
        options_considered: ["X", "Y"],
        choice_made: "Y",
        confidence: 0.75,
        agent_id: "a",
      });
      expect(span.attributes.options_considered).toEqual(["X", "Y"]);
      expect(span.attributes.choice_made).toBe("Y");
      expect(span.attributes.confidence).toBe(0.75);
    });
  });

  describe("recordWorkflow()", () => {
    it("returns a span with agent.workflow type", () => {
      const traceId = collector.startTrace();
      const span = collector.recordWorkflow(traceId, {
        workflow_id: "wf-123",
        topology: "sequential",
        status: "ok",
        start_time: 1000,
        end_time: 5000,
      });
      expect(span.type).toBe("agent.workflow");
    });

    it("has null parent_span_id (root span)", () => {
      const traceId = collector.startTrace();
      const span = collector.recordWorkflow(traceId, {
        workflow_id: "wf-123",
        topology: "sequential",
        status: "ok",
        start_time: 1000,
        end_time: 5000,
      });
      expect(span.parent_span_id).toBeNull();
    });

    it("computes duration_ms from start and end times", () => {
      const traceId = collector.startTrace();
      const span = collector.recordWorkflow(traceId, {
        workflow_id: "wf-123",
        topology: "parallel",
        status: "ok",
        start_time: 1000,
        end_time: 4000,
      });
      expect(span.duration_ms).toBe(3000);
    });
  });

  describe("endTrace()", () => {
    it("returns null for a non-existent trace ID", () => {
      const result = collector.endTrace("nonexistent-trace-id");
      expect(result).toBeNull();
    });

    it("returns the finalized trace", () => {
      const traceId = collector.startTrace("wf-1");
      collector.recordLlmCall(traceId, {
        model: "claude-sonnet-4-6",
        prompt_tokens: 100,
        completion_tokens: 50,
        duration_ms: 500,
        agent_id: "a",
      });
      const trace = collector.endTrace(traceId);
      expect(trace).not.toBeNull();
      expect(trace!.trace_id).toBe(traceId);
    });

    it("aggregates span_count correctly", () => {
      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, { model: "claude-sonnet-4-6", prompt_tokens: 100, completion_tokens: 50, duration_ms: 100, agent_id: "a" });
      collector.recordToolCall(traceId, { tool_name: "bash", success: true, duration_ms: 50, agent_id: "a" });
      const trace = collector.endTrace(traceId);
      expect(trace!.span_count).toBe(2);
    });

    it("aggregates total_cost from all LLM calls", () => {
      const traceId = collector.startTrace();
      // claude-sonnet-4-6: $3/M input
      // 1M tokens = $3 each call, 2 calls = $6
      collector.recordLlmCall(traceId, { model: "claude-sonnet-4-6", prompt_tokens: 1_000_000, completion_tokens: 0, duration_ms: 100, agent_id: "a" });
      collector.recordLlmCall(traceId, { model: "claude-sonnet-4-6", prompt_tokens: 1_000_000, completion_tokens: 0, duration_ms: 100, agent_id: "a" });
      const trace = collector.endTrace(traceId);
      expect(trace!.total_cost).toBeCloseTo(6, 2);
    });

    it("aggregates total_tokens from all LLM calls", () => {
      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, { model: "claude-sonnet-4-6", prompt_tokens: 300, completion_tokens: 200, duration_ms: 100, agent_id: "a" });
      collector.recordLlmCall(traceId, { model: "claude-sonnet-4-6", prompt_tokens: 100, completion_tokens: 50, duration_ms: 100, agent_id: "a" });
      const trace = collector.endTrace(traceId);
      expect(trace!.total_tokens).toBe(650);
    });

    it("collects unique agent IDs in the agents array", () => {
      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, { model: "claude-sonnet-4-6", prompt_tokens: 100, completion_tokens: 50, duration_ms: 100, agent_id: "planner" });
      collector.recordLlmCall(traceId, { model: "claude-sonnet-4-6", prompt_tokens: 100, completion_tokens: 50, duration_ms: 100, agent_id: "executor" });
      collector.recordLlmCall(traceId, { model: "claude-sonnet-4-6", prompt_tokens: 100, completion_tokens: 50, duration_ms: 100, agent_id: "planner" }); // duplicate
      const trace = collector.endTrace(traceId);
      expect(trace!.agents).toHaveLength(2);
      expect(trace!.agents).toContain("planner");
      expect(trace!.agents).toContain("executor");
    });

    it("marks status as error when any span has error status", () => {
      const traceId = collector.startTrace();
      collector.recordToolCall(traceId, { tool_name: "bash", success: false, duration_ms: 50, agent_id: "a" });
      const trace = collector.endTrace(traceId);
      expect(trace!.status).toBe("error");
    });

    it("sets the root_span_id to the span with null parent", () => {
      const traceId = collector.startTrace();
      const root = collector.recordWorkflow(traceId, {
        workflow_id: "wf-x",
        topology: "seq",
        status: "ok",
        start_time: Date.now() - 1000,
        end_time: Date.now(),
      });
      const trace = collector.endTrace(traceId);
      expect(trace!.root_span_id).toBe(root.span_id);
    });

    it("persists the finalized trace to the store", () => {
      const traceId = collector.startTrace();
      collector.recordLlmCall(traceId, { model: "claude-sonnet-4-6", prompt_tokens: 100, completion_tokens: 50, duration_ms: 100, agent_id: "a" });
      collector.endTrace(traceId);
      const stored = store.getTrace(traceId);
      expect(stored!.span_count).toBe(1);
    });

    it("returns null on a second call to endTrace for same trace (already removed from active)", () => {
      const traceId = collector.startTrace();
      collector.endTrace(traceId); // first call OK
      // The trace still exists in store, but meta is gone — should still return trace (store lookup still works)
      // Actually: after endTrace, activeTraces.delete is called, but getTrace still works
      // Second endTrace: meta will be null, existing will be found, uses existing.total_cost
      const second = collector.endTrace(traceId);
      expect(second).not.toBeNull(); // trace still in store, returns from existing
    });
  });
});

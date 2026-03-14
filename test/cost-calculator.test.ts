import { describe, it, expect, beforeEach } from "vitest";
import { CostCalculator } from "../src/index.js";
import type { ModelPricing } from "../src/index.js";

describe("CostCalculator", () => {
  let calc: CostCalculator;

  beforeEach(() => {
    calc = new CostCalculator();
  });

  describe("calculate()", () => {
    it("calculates cost for claude-sonnet-4-6 correctly", () => {
      // $3/M input, $15/M output
      // 1000 prompt tokens = 0.003, 1000 completion tokens = 0.015 => 0.018
      const cost = calc.calculate("claude-sonnet-4-6", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(18, 4); // $3 + $15
    });

    it("calculates cost for claude-opus-4-6 correctly", () => {
      // $15/M input, $75/M output
      const cost = calc.calculate("claude-opus-4-6", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(90, 4);
    });

    it("calculates cost for claude-haiku-4-5 correctly", () => {
      // $0.8/M input, $4/M output
      const cost = calc.calculate("claude-haiku-4-5", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(4.8, 4);
    });

    it("calculates cost for gpt-4o correctly", () => {
      // $2.5/M input, $10/M output
      const cost = calc.calculate("gpt-4o", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(12.5, 4);
    });

    it("calculates cost for gemini-2.5-pro correctly", () => {
      // $1.25/M input, $10/M output
      const cost = calc.calculate("gemini-2.5-pro", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(11.25, 4);
    });

    it("returns 0 for an unknown model", () => {
      expect(calc.calculate("unknown-model-xyz", 1000, 500)).toBe(0);
    });

    it("returns 0 for a model with no close prefix match", () => {
      expect(calc.calculate("completely-fictional-llm", 5000, 5000)).toBe(0);
    });

    it("returns 0 cost when zero tokens are used", () => {
      expect(calc.calculate("claude-sonnet-4-6", 0, 0)).toBe(0);
    });

    it("handles fractional token counts (rounds to 6 decimal places)", () => {
      // 100 tokens at sonnet pricing: 100/1M * 3 = 0.0003 input
      const cost = calc.calculate("claude-sonnet-4-6", 100, 0);
      expect(cost).toBe(0.0003);
    });

    it("prefix-matches claude-opus-4-6 with a dated suffix", () => {
      // "claude-opus-4-6-20260215" should match "claude-opus-4-6"
      const cost = calc.calculate("claude-opus-4-6-20260215", 1_000_000, 0);
      expect(cost).toBeCloseTo(15, 4);
    });

    it("prefix-matches claude-sonnet-4-6 with extra suffix", () => {
      const cost = calc.calculate("claude-sonnet-4-6-latest", 1_000_000, 0);
      expect(cost).toBeCloseTo(3, 4);
    });

    it("uses exact match before prefix match", () => {
      // Exact "sonnet" alias is $3/M input (same as claude-sonnet-4-6 here, just verify it doesn't throw)
      const cost = calc.calculate("sonnet", 1_000_000, 0);
      expect(cost).toBeCloseTo(3, 4);
    });

    it("calculates cost for deepseek-r1", () => {
      // $0.55/M input, $2.19/M output
      const cost = calc.calculate("deepseek-r1", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(2.74, 2);
    });

    it("calculates cost for mistral-large", () => {
      // $2/M input, $6/M output
      const cost = calc.calculate("mistral-large", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(8, 4);
    });
  });

  describe("setPricing()", () => {
    it("adds a new model pricing entry", () => {
      calc.setPricing({ model: "my-custom-llm", input_cost_per_million: 5, output_cost_per_million: 20 });
      const cost = calc.calculate("my-custom-llm", 1_000_000, 0);
      expect(cost).toBeCloseTo(5, 4);
    });

    it("overrides an existing model's pricing", () => {
      calc.setPricing({ model: "claude-sonnet-4-6", input_cost_per_million: 100, output_cost_per_million: 100 });
      const cost = calc.calculate("claude-sonnet-4-6", 1_000_000, 0);
      expect(cost).toBeCloseTo(100, 4);
    });
  });

  describe("getPricing()", () => {
    it("returns pricing for a known model", () => {
      const pricing = calc.getPricing("claude-sonnet-4-6");
      expect(pricing).not.toBeNull();
      expect(pricing!.input_cost_per_million).toBe(3);
      expect(pricing!.output_cost_per_million).toBe(15);
    });

    it("returns null for an unknown model", () => {
      expect(calc.getPricing("totally-made-up")).toBeNull();
    });

    it("returns pricing via prefix match", () => {
      const pricing = calc.getPricing("claude-opus-4-6-20260215");
      expect(pricing).not.toBeNull();
      expect(pricing!.input_cost_per_million).toBe(15);
    });
  });

  describe("listPricing()", () => {
    it("returns all default models", () => {
      const list = calc.listPricing();
      expect(list.length).toBeGreaterThan(10);
    });

    it("includes custom pricing in list after setPricing", () => {
      const custom: ModelPricing = { model: "test-model", input_cost_per_million: 1, output_cost_per_million: 2 };
      calc.setPricing(custom);
      const list = calc.listPricing();
      expect(list.some((p) => p.model === "test-model")).toBe(true);
    });

    it("returns ModelPricing objects with required fields", () => {
      const list = calc.listPricing();
      for (const p of list) {
        expect(p).toHaveProperty("model");
        expect(p).toHaveProperty("input_cost_per_million");
        expect(p).toHaveProperty("output_cost_per_million");
      }
    });
  });

  describe("constructor with customPricing", () => {
    it("initializes with custom pricing overrides applied at construction", () => {
      const custom = new CostCalculator([
        { model: "claude-sonnet-4-6", input_cost_per_million: 999, output_cost_per_million: 999 },
      ]);
      const cost = custom.calculate("claude-sonnet-4-6", 1_000_000, 0);
      expect(cost).toBeCloseTo(999, 4);
    });

    it("initializes with new models alongside defaults", () => {
      const custom = new CostCalculator([
        { model: "brand-new-model", input_cost_per_million: 7, output_cost_per_million: 21 },
      ]);
      expect(custom.calculate("brand-new-model", 1_000_000, 0)).toBeCloseTo(7, 4);
      // Default models still available
      expect(custom.calculate("gpt-4o", 1_000_000, 0)).toBeCloseTo(2.5, 4);
    });
  });
});

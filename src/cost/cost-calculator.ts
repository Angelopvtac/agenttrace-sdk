/**
 * CostCalculator — Computes dollar costs from model name and token counts.
 * Ships with built-in pricing for Claude models; pricing is configurable.
 */

import type { ModelPricing } from "../types.js";

/** Default pricing per million tokens (USD) as of early 2026. */
const DEFAULT_PRICING: ModelPricing[] = [
  // Anthropic — Claude
  { model: "claude-opus-4-6", input_cost_per_million: 15, output_cost_per_million: 75 },
  { model: "claude-sonnet-4-6", input_cost_per_million: 3, output_cost_per_million: 15 },
  { model: "claude-haiku-4-5", input_cost_per_million: 0.8, output_cost_per_million: 4 },
  // Aliases
  { model: "opus", input_cost_per_million: 15, output_cost_per_million: 75 },
  { model: "sonnet", input_cost_per_million: 3, output_cost_per_million: 15 },
  { model: "haiku", input_cost_per_million: 0.8, output_cost_per_million: 4 },

  // OpenAI
  { model: "gpt-4o", input_cost_per_million: 2.5, output_cost_per_million: 10 },
  { model: "gpt-4o-mini", input_cost_per_million: 0.15, output_cost_per_million: 0.6 },
  { model: "gpt-4.1", input_cost_per_million: 2, output_cost_per_million: 8 },
  { model: "gpt-4.1-mini", input_cost_per_million: 0.4, output_cost_per_million: 1.6 },
  { model: "gpt-4.1-nano", input_cost_per_million: 0.1, output_cost_per_million: 0.4 },
  { model: "o3", input_cost_per_million: 10, output_cost_per_million: 40 },
  { model: "o3-mini", input_cost_per_million: 1.1, output_cost_per_million: 4.4 },
  { model: "o4-mini", input_cost_per_million: 1.1, output_cost_per_million: 4.4 },

  // Google
  { model: "gemini-2.5-pro", input_cost_per_million: 1.25, output_cost_per_million: 10 },
  { model: "gemini-2.5-flash", input_cost_per_million: 0.15, output_cost_per_million: 0.6 },
  { model: "gemini-2.0-flash", input_cost_per_million: 0.1, output_cost_per_million: 0.4 },

  // Meta (via common providers)
  { model: "llama-4-scout", input_cost_per_million: 0.18, output_cost_per_million: 0.59 },
  { model: "llama-4-maverick", input_cost_per_million: 0.19, output_cost_per_million: 0.85 },

  // Mistral
  { model: "mistral-large", input_cost_per_million: 2, output_cost_per_million: 6 },
  { model: "mistral-small", input_cost_per_million: 0.1, output_cost_per_million: 0.3 },
  { model: "codestral", input_cost_per_million: 0.3, output_cost_per_million: 0.9 },

  // DeepSeek
  { model: "deepseek-r1", input_cost_per_million: 0.55, output_cost_per_million: 2.19 },
  { model: "deepseek-v3", input_cost_per_million: 0.27, output_cost_per_million: 1.1 },
];

export class CostCalculator {
  private pricing: Map<string, ModelPricing>;

  constructor(customPricing?: ModelPricing[]) {
    this.pricing = new Map();
    for (const p of DEFAULT_PRICING) {
      this.pricing.set(p.model, p);
    }
    if (customPricing) {
      for (const p of customPricing) {
        this.pricing.set(p.model, p);
      }
    }
  }

  /**
   * Calculate the cost for a single LLM call.
   * @returns Cost in USD. Returns 0 if model is unknown.
   */
  calculate(model: string, promptTokens: number, completionTokens: number): number {
    const pricing = this.findPricing(model);
    if (!pricing) return 0;

    const inputCost = (promptTokens / 1_000_000) * pricing.input_cost_per_million;
    const outputCost = (completionTokens / 1_000_000) * pricing.output_cost_per_million;
    return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal precision
  }

  /**
   * Add or update pricing for a model.
   */
  setPricing(pricing: ModelPricing): void {
    this.pricing.set(pricing.model, pricing);
  }

  /**
   * Get the pricing config for a model, or null if unknown.
   */
  getPricing(model: string): ModelPricing | null {
    return this.findPricing(model);
  }

  /**
   * List all configured model pricings.
   */
  listPricing(): ModelPricing[] {
    return [...this.pricing.values()];
  }

  private findPricing(model: string): ModelPricing | null {
    // Exact match first
    const exact = this.pricing.get(model);
    if (exact) return exact;

    // Prefix match (e.g., "claude-opus-4-6-20260215" matches "claude-opus-4-6")
    for (const [key, pricing] of this.pricing) {
      if (model.startsWith(key)) return pricing;
    }

    return null;
  }
}

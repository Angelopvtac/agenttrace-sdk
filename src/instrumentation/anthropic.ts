import type { PatchContext, PatchResult } from "./types.js";
import { truncate } from "./utils.js";

export interface AnthropicPatchTarget {
  Messages: {
    prototype: {
      create: (...args: any[]) => Promise<any>;
    };
  };
}

// NOTE: Streaming responses (stream: true) are not instrumented.
// When streaming, the response is an AsyncIterable without a usage field.
// Token counts and cost will be recorded as 0 for streamed calls.
export function patchAnthropic(target: AnthropicPatchTarget, ctx: PatchContext): PatchResult {
  const origCreate = target.Messages.prototype.create;

  target.Messages.prototype.create = async function (
    this: any,
    ...args: any[]
  ) {
    const traceId = ctx.getActiveTrace();
    if (!traceId) {
      return origCreate.apply(this, args);
    }

    const startTime = Date.now();
    const params = args[0] ?? {};

    try {
      const response = await origCreate.apply(this, args);
      const durationMs = Date.now() - startTime;
      const usage = response?.usage;
      const model = response?.model ?? params.model ?? "unknown";

      // Anthropic uses input_tokens/output_tokens
      const promptTokens = usage?.input_tokens ?? 0;
      const completionTokens = usage?.output_tokens ?? 0;

      const extraAttributes: Record<string, unknown> = {};
      if (ctx.captureContent) {
        extraAttributes.input = truncate(params.messages);
        const text = response?.content
          ?.map((b: any) => b.text ?? "")
          .join("");
        extraAttributes.output = truncate(text ?? "");
      }

      ctx.collector.recordLlmCall(traceId, {
        model,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        duration_ms: durationMs,
        agent_id: ctx.agentId,
        status: "ok",
        extraAttributes,
      });

      return response;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const model = params.model ?? "unknown";
      const errorMessage = error instanceof Error ? error.message : String(error);

      ctx.collector.recordLlmCall(traceId, {
        model,
        prompt_tokens: 0,
        completion_tokens: 0,
        duration_ms: durationMs,
        agent_id: ctx.agentId,
        status: "error",
        extraAttributes: { error: truncate(errorMessage) },
      });

      throw error;
    }
  };

  return {
    framework: "anthropic",
    restore() {
      target.Messages.prototype.create = origCreate;
    },
  };
}

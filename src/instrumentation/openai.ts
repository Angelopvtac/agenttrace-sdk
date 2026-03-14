import type { PatchContext, PatchResult } from "./types.js";

const MAX_CONTENT_LENGTH = 10_240;

function truncate(value: unknown): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return str.length > MAX_CONTENT_LENGTH ? str.slice(0, MAX_CONTENT_LENGTH) : str;
}

export interface OpenAIPatchTarget {
  Chat: {
    Completions: {
      prototype: {
        create: (...args: any[]) => Promise<any>;
      };
    };
  };
  Embeddings: {
    prototype: {
      create: (...args: any[]) => Promise<any>;
    };
  };
}

export function patchOpenAI(target: OpenAIPatchTarget, ctx: PatchContext): PatchResult {
  const origChat = target.Chat.Completions.prototype.create;
  const origEmbed = target.Embeddings.prototype.create;

  target.Chat.Completions.prototype.create = async function (
    this: any,
    ...args: any[]
  ) {
    const traceId = ctx.getActiveTrace();
    if (!traceId) {
      return origChat.apply(this, args);
    }

    const startTime = Date.now();
    const params = args[0] ?? {};

    try {
      const response = await origChat.apply(this, args);
      const durationMs = Date.now() - startTime;
      const usage = response?.usage;
      const model = response?.model ?? params.model ?? "unknown";

      const extraAttributes: Record<string, unknown> = {};
      if (ctx.captureContent) {
        extraAttributes.input = truncate(params.messages);
        const content = response?.choices?.[0]?.message?.content;
        extraAttributes.output = truncate(content ?? "");
      }

      ctx.collector.recordLlmCall(traceId, {
        model,
        prompt_tokens: usage?.prompt_tokens ?? 0,
        completion_tokens: usage?.completion_tokens ?? 0,
        duration_ms: durationMs,
        agent_id: ctx.agentId,
        status: "ok",
        extraAttributes,
      });

      return response;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const model = params.model ?? "unknown";

      ctx.collector.recordLlmCall(traceId, {
        model,
        prompt_tokens: 0,
        completion_tokens: 0,
        duration_ms: durationMs,
        agent_id: ctx.agentId,
        status: "error",
      });

      throw error;
    }
  };

  target.Embeddings.prototype.create = async function (
    this: any,
    ...args: any[]
  ) {
    const traceId = ctx.getActiveTrace();
    if (!traceId) {
      return origEmbed.apply(this, args);
    }

    const startTime = Date.now();
    const params = args[0] ?? {};

    try {
      const response = await origEmbed.apply(this, args);
      const durationMs = Date.now() - startTime;
      const usage = response?.usage;
      const model = response?.model ?? params.model ?? "unknown";

      ctx.collector.recordLlmCall(traceId, {
        model,
        prompt_tokens: usage?.prompt_tokens ?? usage?.total_tokens ?? 0,
        completion_tokens: 0,
        duration_ms: durationMs,
        agent_id: ctx.agentId,
        status: "ok",
      });

      return response;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const model = params.model ?? "unknown";

      ctx.collector.recordLlmCall(traceId, {
        model,
        prompt_tokens: 0,
        completion_tokens: 0,
        duration_ms: durationMs,
        agent_id: ctx.agentId,
        status: "error",
      });

      throw error;
    }
  };

  return {
    framework: "openai",
    restore() {
      target.Chat.Completions.prototype.create = origChat;
      target.Embeddings.prototype.create = origEmbed;
    },
  };
}

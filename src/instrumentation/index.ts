import type { TraceCollector } from "../collector/trace-collector.js";
import type { FrameworkName, PatchContext, PatchResult } from "./types.js";
import { patchOpenAI, type OpenAIPatchTarget } from "./openai.js";
import { patchAnthropic, type AnthropicPatchTarget } from "./anthropic.js";

export type { InstrumentationOptions, FrameworkName, PatchContext, PatchResult } from "./types.js";
export { patchOpenAI, type OpenAIPatchTarget } from "./openai.js";
export { patchAnthropic, type AnthropicPatchTarget } from "./anthropic.js";

export interface InstrumentationManagerOptions {
  collector: TraceCollector;
  frameworks: FrameworkName[];
  agentId?: string;
  captureContent?: boolean;
  autoTrace?: boolean;
  autoTraceIdleMs?: number;
  targets?: {
    openai?: OpenAIPatchTarget;
    anthropic?: AnthropicPatchTarget;
  };
}

export class InstrumentationManager {
  private patches: PatchResult[] = [];
  private activeTraceId: string | null = null;
  private collector: TraceCollector;
  private autoTrace: boolean;
  private autoTraceIdleMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  readonly patchedFrameworks: FrameworkName[];

  constructor(options: InstrumentationManagerOptions) {
    this.collector = options.collector;
    this.autoTrace = options.autoTrace ?? false;
    this.autoTraceIdleMs = options.autoTraceIdleMs ?? 30_000;
    this.patchedFrameworks = [];

    const ctx: PatchContext = {
      collector: options.collector,
      agentId: options.agentId ?? "default",
      captureContent: options.captureContent ?? false,
      getActiveTrace: () => this.resolveActiveTrace(),
    };

    for (const fw of options.frameworks) {
      const target = options.targets?.[fw] ?? this.tryRequire(fw);
      if (!target) continue;

      let patch: PatchResult;
      if (fw === "openai") {
        patch = patchOpenAI(target as OpenAIPatchTarget, ctx);
      } else {
        patch = patchAnthropic(target as AnthropicPatchTarget, ctx);
      }
      this.patches.push(patch);
      this.patchedFrameworks.push(fw);
    }
  }

  setActiveTrace(traceId: string): void {
    this.activeTraceId = traceId;
  }

  getActiveTrace(): string | null {
    return this.activeTraceId;
  }

  clearActiveTrace(): void {
    this.activeTraceId = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  restore(): void {
    for (const patch of this.patches) {
      patch.restore();
    }
    this.patches = [];
    this.patchedFrameworks.length = 0;
    this.clearActiveTrace();
  }

  private resolveActiveTrace(): string | null {
    if (this.activeTraceId) {
      this.resetIdleTimer();
      return this.activeTraceId;
    }

    if (this.autoTrace) {
      this.activeTraceId = this.collector.startTrace();
      this.resetIdleTimer();
      return this.activeTraceId;
    }

    return null;
  }

  private resetIdleTimer(): void {
    if (!this.autoTrace) return;

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      if (this.activeTraceId) {
        this.collector.endTrace(this.activeTraceId);
        this.activeTraceId = null;
      }
      this.idleTimer = null;
    }, this.autoTraceIdleMs);
  }

  private tryRequire(framework: FrameworkName): any {
    try {
      if (framework === "openai") {
        return require("openai");
      } else {
        return require("@anthropic-ai/sdk");
      }
    } catch {
      return null;
    }
  }
}

export function setupInstrumentation(
  options: Omit<InstrumentationManagerOptions, "targets">
): InstrumentationManager {
  return new InstrumentationManager(options);
}

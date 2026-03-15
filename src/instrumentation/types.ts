import type { TraceCollector } from "../collector/trace-collector.js";

export type FrameworkName = "openai" | "anthropic";

export interface InstrumentationOptions {
  collector: TraceCollector;
  frameworks: FrameworkName[];
  agentId?: string;
  captureContent?: boolean;
  autoTrace?: boolean;
}

export interface PatchContext {
  collector: TraceCollector;
  agentId: string;
  captureContent: boolean;
  getActiveTrace: () => string | null;
}

export interface PatchResult {
  framework: FrameworkName;
  restore: () => void;
}

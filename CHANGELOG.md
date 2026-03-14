# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-03-14

### Added

- **OtlpExporter** — exports spans from the local SQLite store to any OpenTelemetry-compatible collector via OTLP/HTTP. Supports single-trace export (`exportTrace`), filtered bulk export (`exportAll`), and graceful shutdown. Wraps `@opentelemetry/exporter-trace-otlp-http`.
- **GenAI semantic convention mapping** — LLM call attributes are mapped to OpenTelemetry GenAI semantic conventions when exporting via `OtlpExporter`, enabling first-class support in collectors that understand those conventions.
- **CONTRIBUTING.md** — prerequisites, setup steps, development workflow, code style rules, and PR guidelines.
- **SECURITY.md** — supported versions, private disclosure instructions, and response timeline.
- **45 new tests** for `OtlpExporter` (216 total).

### Changed

- Package renamed from `agenttrace` to `agenttrace-sdk` on npm.
- `.gitignore` updated to exclude `dist/`, `node_modules/`, and SQLite database files.

[0.2.0]: https://github.com/angelofrisina/agenttrace/releases/tag/v0.2.0

## [0.1.0] - 2026-03-13

### Added

- **TraceStore** — SQLite-backed persistence layer with WAL mode for spans, traces, cost records, agent baselines, and anomaly alerts. Supports in-memory mode (`":memory:"`) for testing. Includes filtered trace listing with support for time range, agent, workflow, status, cost range, and anomaly presence.
- **TraceCollector** — OpenTelemetry-compatible span collection for agent events. Records LLM calls (with automatic cost calculation), tool calls, inter-agent messages, decision points, and workflow spans. Maintains active trace metadata and finalizes aggregate metrics on `endTrace`.
- **CostCalculator** — Computes dollar costs from model name and token counts. Ships with built-in pricing for 20+ models across Anthropic, OpenAI, Google, Meta, Mistral, and DeepSeek. Supports custom pricing and prefix-based model name matching.
- **CostAttributor** — Aggregates cost records into breakdown reports by agent, model, or workflow. Methods: `getCostByWorkflow`, `getCostByAgent`, `getCostBreakdown`, `getCostBreakdownByModel`, `getAgentCostBreakdown`.
- **FlameGraphBuilder** — Reconstructs hierarchical execution trees from flat span records. Exports d3-flame-graph compatible JSON with `name`, `value` (duration), `cost`, `tokens`, `type`, and `status` fields. Wraps multiple root spans in a synthetic root node.
- **AnomalyDetector** — Detects anomalous agent behavior using rolling EMA baselines persisted to SQLite. Detects: cost spikes, token spikes, latency spikes, error cascades, loop detection (same tool with similar args repeated beyond threshold), and unusual tool usage frequency. Configurable spike threshold, loop threshold, and minimum sample count before baselines are trusted.
- **171 tests** across 6 test files covering all public classes (vitest).
- **CI pipeline** via GitHub Actions: typecheck and full test suite on Node 22 for pushes and pull requests to main.

[0.1.0]: https://github.com/angelofrisina/agenttrace/releases/tag/v0.1.0

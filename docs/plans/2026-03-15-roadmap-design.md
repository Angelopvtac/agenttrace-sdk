# AgentTrace 2026 Roadmap

**Date:** 2026-03-15
**Status:** Approved
**Strategic Position:** Infrastructure layer — the OpenTelemetry for AI agents
**Business Model:** Open core — free SDK/CLI, paid cloud dashboard
**Builder:** Solo (Angelo + Claude)

## Vision

AgentTrace becomes the standard trace format for AI agent workflows. The SDKs are free reference implementations. The spec is the product. Revenue comes from a paid cloud layer built on top of the standard.

## Phase 1: The Wedge (April 2026)

### CLI Trace Inspector

`npx agenttrace inspect ./traces.db`

Terminal-based trace browser:
- Trace listing with cost/duration/status summary
- Drill-down showing span tree (indented, color-coded by type)
- Cost breakdown table per agent/model
- Anomaly timeline highlighting flagged spans

No browser, no server, no signup. Point at a SQLite file.

`npx agenttrace watch ./traces.db` — live streaming mode.

### Streaming Span Recording

EventEmitter interface on TraceCollector:

```typescript
collector.on("span", (span) => { /* real-time consumption */ });
collector.on("anomaly", (alert) => { /* live alerting */ });
```

Enables live CLI watch mode, piping to Slack alerts, log aggregators, custom consumers.

Both ship as part of `agenttrace-sdk` — no separate packages.

### Success Metrics
- npm weekly downloads: 500+
- GitHub stars: 200+

---

## Phase 2: Cross-Language Standard (May-June 2026)

### Python SDK

`pip install agenttrace`

Python port of core SDK: TraceStore (SQLite), TraceCollector, CostCalculator, auto-instrumentation for `openai` and `anthropic` Python packages. Same SQLite schema — a Python agent and TypeScript agent can write to the same database file.

### Trace Format Specification

`docs/spec/agenttrace-v1.md`

Formalize into a versioned spec:
- SQLite schema definition (tables, columns, types, constraints)
- Span type taxonomy (`agent.llm_call`, `agent.tool_call`, etc.)
- SpanAttributes contract per type
- Cost record format
- Anomaly alert format
- Export mappings to OTel GenAI semantic conventions

Published as markdown in repo and standalone page. Other tools implement readers/writers against the spec.

### Success Metrics
- PyPI weekly downloads: 300+
- Spec adopted by 1+ external tool

---

## Phase 3: Ecosystem Expansion (Q3 — July-September 2026)

### Framework Adapters

Separate optional packages:
- `@agenttrace/langchain` — patch `ChatModel.invoke()` and tool execution
- `@agenttrace/vercel-ai` — patch `generateText()` / `streamText()`
- `@agenttrace/crewai` — patch agent execution and task delegation

Python equivalents for LangChain and CrewAI from the Python SDK.

### Community Tooling Foundation

- `@agenttrace/reader` — lightweight read-only package for consuming trace databases
- Documented plugin interface for custom span types
- GitHub templates for "build an AgentTrace plugin"

### Success Metrics
- Framework adapters: 3+
- External contributors: 5+

---

## Phase 4: Monetization Layer (Q4 — October-December 2026)

### AgentTrace Cloud

#### Free (SDK + CLI) — forever
- All SDKs (TypeScript, Python, future languages)
- CLI inspector and watch mode
- All framework adapters
- SQLite storage, self-hosted, unlimited
- OTLP export
- Anomaly detection
- Flame graph export
- The trace format spec

#### Paid (Cloud Dashboard)
- Web UI reading from OTLP export or SQLite upload
- Team collaboration — shared trace views, annotations, bookmarks
- Persistent anomaly alerting — Slack/email/webhook
- Cross-run analytics — cost trends, agent performance regression detection
- Trace comparison — diff two runs side-by-side
- Team management

#### Architecture
Cloud product is a consumer of the spec, not a fork. Users push traces via OTLP or `agenttrace push` CLI. The SDK never phones home.

#### Pricing
Usage-based on stored traces. Free tier with generous limits for solo developers. Paid tiers for teams and production.

### Success Metrics
- Paid users: 50+
- MRR: $2k+

---

## Decisions

- **Infrastructure layer over product:** The spec is the moat. SDKs are reference implementations.
- **CLI inspector as wedge:** Unique differentiator no competitor has. Proves embedded story viscerally.
- **Python SDK before framework adapters:** Cross-language proof > breadth of JS integrations.
- **Cloud dashboard last:** Build adoption and standard first, monetize the base.
- **Spec after Python SDK:** Need real cross-language usage data before formalizing.

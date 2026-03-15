#!/usr/bin/env node
/**
 * AgentTrace CLI — inspect traces from the terminal.
 *
 * Usage:
 *   agenttrace inspect <db-path>
 *   agenttrace inspect <db-path> --trace <id>
 *   agenttrace inspect <db-path> --costs
 *   agenttrace inspect <db-path> --anomalies
 *   agenttrace costs <db-path>
 *   agenttrace anomalies <db-path>
 */

import { runInspect } from "./commands/inspect.js";
import { runCosts } from "./commands/costs.js";
import { runAnomalies } from "./commands/anomalies.js";

const USAGE = `
AgentTrace CLI — Inspect agent traces from the terminal

Usage:
  agenttrace inspect <db-path>                  List recent traces
  agenttrace inspect <db-path> --trace <id>     Drill into a single trace
  agenttrace inspect <db-path> --costs          Cost breakdown by model
  agenttrace inspect <db-path> --anomalies      List anomaly alerts
  agenttrace costs <db-path>                    Cost breakdown (alias)
  agenttrace anomalies <db-path>                Anomaly alerts (alias)

Options:
  --trace <id>    Trace ID to inspect (partial IDs are NOT supported)
  --limit <n>     Limit number of results (default: 20)
  --help          Show this help message
`.trim();

function parseArgs(argv: string[]): {
  command: string;
  dbPath: string;
  traceId?: string;
  showCosts: boolean;
  showAnomalies: boolean;
  limit: number;
  help: boolean;
} {
  const args = argv.slice(2); // strip node + script path

  let command = "";
  let dbPath = "";
  let traceId: string | undefined;
  let showCosts = false;
  let showAnomalies = false;
  let limit = 20;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--trace") {
      traceId = args[++i];
    } else if (arg === "--costs") {
      showCosts = true;
    } else if (arg === "--anomalies") {
      showAnomalies = true;
    } else if (arg === "--limit") {
      const raw = args[++i];
      if (raw !== undefined) {
        const n = parseInt(raw, 10);
        if (!isNaN(n) && n > 0) limit = n;
      }
    } else if (command === "") {
      command = arg;
    } else if (dbPath === "") {
      dbPath = arg;
    }
  }

  return { command, dbPath, traceId, showCosts, showAnomalies, limit, help };
}

function main(): void {
  const { command, dbPath, traceId, showCosts, showAnomalies, help } =
    parseArgs(process.argv);

  if (help || command === "" || command === "--help") {
    console.log(USAGE);
    process.exit(0);
  }

  if (command === "inspect") {
    if (!dbPath) {
      console.error("Error: db-path is required\n");
      console.log(USAGE);
      process.exit(1);
    }

    if (showCosts) {
      runCosts(dbPath);
    } else if (showAnomalies) {
      runAnomalies(dbPath);
    } else {
      runInspect(dbPath, traceId);
    }
  } else if (command === "costs") {
    const path = dbPath;
    if (!path) {
      console.error("Error: db-path is required\n");
      console.log(USAGE);
      process.exit(1);
    }
    runCosts(path);
  } else if (command === "anomalies") {
    const path = dbPath;
    if (!path) {
      console.error("Error: db-path is required\n");
      console.log(USAGE);
      process.exit(1);
    }
    runAnomalies(path);
  } else {
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    process.exit(1);
  }
}

main();

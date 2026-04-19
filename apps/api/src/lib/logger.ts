// Import env first — this is the entry point for many modules
import "../lib/env"; // side-effect: loads dotenv

import pino from "pino";

// export const logger = pino({
//   level: process.env.LOG_LEVEL ?? "info",
//   transport:
//     process.env.NODE_ENV !== "production"
//       ? { target: "pino-pretty", options: { colorize: true } }
//       : undefined,
//   base: { service: "interview-api" },
// });

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "interview-api" },
});


import path from "node:path";
import fs   from "node:fs";
import { fileURLToPath } from "node:url";

// ESM-compatible __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Resolve <turborepo-root>/logs/ ─────────────────────────────────────────
// Works regardless of which package/app imports this module.
function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (
      fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) ||
      fs.existsSync(path.join(dir, "turbo.json"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start; // reached filesystem root — fallback
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(__dirname);const LOGS_DIR  = path.join(REPO_ROOT, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true }); // ensure folder exists

const LOG_FILE  = path.join(LOGS_DIR, "state-machine.log");

// ── Pino transport: file + pretty console (dev only) ──────────────────────
const isDev = process.env.NODE_ENV !== "production";

const transport = pino.transport({
  targets: [
    // Always write structured JSON to the log file
    {
      target : "pino/file",
      level  : "trace",
      options: { destination: LOG_FILE, append: true, mkdir: true },
    },
    // Pretty-print to stdout in development
    ...(isDev
      ? [{
          target : "pino-pretty",
          level  : "trace",
          options: {
            colorize       : true,
            translateTime  : "SYS:HH:MM:ss.l",
            ignore         : "pid,hostname",
            messageFormat  : "{msg}  [{stateName}]  status={status}",
          },
        }]
      : []),
  ],
});

export const smLogger = pino(
  {
    level       : "trace",
    base        : { service: "state-machine" },
    timestamp   : pino.stdTimeFunctions.isoTime,
  },
  transport,
);


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
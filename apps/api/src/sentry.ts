/**
 * src/sentry.ts — production hardened
 *
 * Changes from original:
 *
 * [MEDIUM-16] Sentry receives unredacted error objects containing PII
 *   - sendDefaultPii set to false (was true)
 *   - beforeSend hook scrubs request bodies and common PII patterns
 *     from error messages (JWTs, email addresses)
 *   - tracesSampleRate reduced to 0.1 in production
 */

import "./lib/env.js";
import * as Sentry from "@sentry/node";

const isProd = process.env.NODE_ENV === "production";

// JWT pattern (eyJ…)
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
// Email pattern
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function redactString(s: string): string {
  return s.replace(JWT_PATTERN, "[JWT]").replace(EMAIL_PATTERN, "[EMAIL]");
}

export function initSentry(): void {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,

    // Never send request bodies, user IP, or PII by default
    sendDefaultPii: false,

    // Sample fewer traces in production to reduce cost
    tracesSampleRate: isProd ? 0.1 : 1.0,

    environment: process.env.NODE_ENV ?? "development",

    integrations: [Sentry.httpIntegration()],

    beforeSend(event) {
      // Strip request body entirely — may contain resume/JD text
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          delete event.request.headers["authorization"];
          delete event.request.headers["cookie"];
        }
        // Scrub query string (may contain nonce tokens)
        if (event.request.query_string) {
          event.request.query_string = "[redacted]";
        }
      }

      // Scrub PII from exception messages
      if (event.exception?.values) {
        for (const ex of event.exception.values) {
          if (ex.value) {
            ex.value = redactString(ex.value);
          }
          if (ex.stacktrace?.frames) {
            for (const frame of ex.stacktrace.frames) {
              if (frame.vars) {
                // Remove all local variable captures — may contain user data
                frame.vars = {};
              }
            }
          }
        }
      }

      // Scrub message-level PII
      if (typeof event.message === "string") {
        event.message = redactString(event.message);
      }

      return event;
    },
  });
}

import * as Sentry from "@sentry/node";

export function initSentry() {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    sendDefaultPii: true,

    tracesSampleRate: 1.0, // dev: 100%, reduce in prod

    environment: process.env.NODE_ENV || "development",

    integrations: [
      Sentry.httpIntegration(),
    ],
  });
}
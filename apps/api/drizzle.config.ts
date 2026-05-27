import { config } from "dotenv";
import { resolve } from "path";
import type { Config } from "drizzle-kit";

// drizzle-kit uses its own TS loader and never runs the app bootstrap,
// so src/lib/env.ts is not available here. We can't import it either
// because it calls require_env() for GROQ_API_KEY, CLERK_DOMAIN, etc.
// — vars that aren't needed by drizzle and may not be set in a CI
// migrate-only job.
//
// Mirror the same two-level load that src/lib/env.ts uses:
//   1. apps/api/.env          (local override, gitignored)
//   2. ../../.env             (monorepo root)
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env"), override: false });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL not set.\n" +
    "Create apps/api/.env or ensure the monorepo root .env contains DATABASE_URL."
  );
}

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  verbose: true,
  strict: true,
} satisfies Config;
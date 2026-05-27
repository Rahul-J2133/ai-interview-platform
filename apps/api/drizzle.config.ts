import { config } from "dotenv";
import { resolve } from "path";
import type { Config } from "drizzle-kit";

config({ path: resolve(process.cwd(), ".env"), debug: true });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL not set. Add it to .env");
}

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  verbose: true,
  strict: true,
} satisfies Config;

// npx drizzle-kit studio
// npx drizzle-kit generate
// npx drizzle-kit migrate

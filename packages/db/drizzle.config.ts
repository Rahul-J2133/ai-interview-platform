import { config } from "dotenv";
import { resolve } from "path";
import type { Config } from "drizzle-kit";

// Load env when drizzle-kit runs from the packages/db directory
// or from apps/api (where the .env lives)
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../apps/api/.env"), override: false });
config({ path: resolve(process.cwd(), "../../../apps/api/.env"), override: false });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL not set. Run from apps/api/ or set DATABASE_URL in packages/db/.env"
  );
}

export default {
  schema: "./src/schema.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  verbose: true,
  strict: true,
} satisfies Config;

// npx drizzle-kit studio/
// docker exec -it interview_postgres psql -U postgres -d interview_platform -c "SELECT * FROM users;"
// docker compose --profile tools up -d
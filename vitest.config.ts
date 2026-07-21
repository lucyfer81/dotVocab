import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const schema = readFileSync(
  fileURLToPath(new URL("./migrations/0001_init.sql", import.meta.url)),
  "utf8"
);

export default defineWorkersConfig({
  define: { SCHEMA_SQL: JSON.stringify(schema) },
  test: {
    poolOptions: {
      workers: { wrangler: { configPath: "./wrangler.toml" } },
    },
  },
});

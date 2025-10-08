import type { Config } from "drizzle-kit";

export default {
  schema: "./packages/demo/server/db/schema.ts",
  out: "./packages/demo/drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "file:./sqlite.db",
  },
} satisfies Config;
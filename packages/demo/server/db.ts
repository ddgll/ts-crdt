import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "./db/schema.js";

export const db = drizzle(createClient({ url: "file:sqlite.db" }), { schema });

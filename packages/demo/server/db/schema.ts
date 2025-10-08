import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Op } from "../../src/eventGraph/eventGraph.js";

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  replicaId: text("replicaId").notNull(),
  parents: text("parents", { mode: "json" }).$type<string[]>().notNull(),
  op: text("op", { mode: "json" }).$type<Op>().notNull(),
});

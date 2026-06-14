import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { migrate } from "drizzle-orm/libsql/migrator";
import { handleWebSocket, resetServer, Repository } from "@ddgll/ts-crdt/server";
import { eq } from "drizzle-orm";
import * as schema from "./db/schema.js";

const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

const db = drizzle(createClient({ url: "file:sqlite.db" }), { schema });

const repositories = new Map<string, Repository>();

function getRoomRepository(roomId: string): Repository {
  let repo = repositories.get(roomId);
  if (!repo) {
    repo = {
      getEvents: async () => {
        return await db
          .select()
          .from(schema.events)
          .where(eq(schema.events.roomId, roomId));
      },
      saveEvent: async (event) => {
        await db.insert(schema.events).values({
          id: event.id,
          roomId,
          replicaId: event.replicaId,
          parents: event.parents,
          op: event.op,
        });
      },
      clearEvents: async () => {
        await db.delete(schema.events).where(eq(schema.events.roomId, roomId));
      },
    };
    repositories.set(roomId, repo);
  }
  return repo;
}

async function initializeServer() {
  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");

  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      const roomId = c.req.query("room") || "default";
      const roomRepository = getRoomRepository(roomId);
      return {
        onOpen: (_evt, webSocket) => {
          if (!webSocket.raw) {
            console.error("WebSocket is undefined");
            return;
          }
          handleWebSocket(webSocket.raw, roomRepository).catch((err) => {
            console.error("WebSocket handling error:", err);
          });
        },
      };
    }),
  );

  app.get("/reset", async (c) => {
    const roomId = c.req.query("room") || "default";
    const roomRepository = getRoomRepository(roomId);
    await resetServer(roomRepository);
    console.log(`State and database reset for room ${roomId}`);
    return c.text(`State and database reset for room ${roomId}`);
  });

  // Serve static files AFTER the WebSocket route
  app.use("/*", serveStatic({ root: "./interactive-test" }));

  const server = serve(
    {
      fetch: app.fetch,
      port: 3000,
    },
    (info) => {
      console.log(`Server is running at http://localhost:${info.port}`);
    },
  );

  injectWebSocket(server);
}

initializeServer().catch((err) => {
  console.error("Failed to initialize server:", err);
  process.exit(1);
});

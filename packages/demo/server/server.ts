import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { migrate } from "drizzle-orm/libsql/migrator";
import { handleWebSocket, resetServer, Repository, BufferedRepository, InMemoryPubSubAdapter } from "@ddgll/ts-crdt/server";
import { db } from "./db.js";
import { SqliteRoomRepository } from "./roomRepository.js";
import { InMemoryTextRepository } from "./inMemoryTextRepository.js";

const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

const sqliteRepositories = new Map<string, Repository>();
const textRepositories = new Map<string, Repository>();
const pubSub = new InMemoryPubSubAdapter();

function getRoomRepository(roomId: string): Repository {
  let repo = sqliteRepositories.get(roomId);
  if (!repo) {
    const rawRepo = new SqliteRoomRepository(roomId);
    repo = new BufferedRepository(rawRepo, { flushIntervalMs: 500, batchSize: 20 });
    sqliteRepositories.set(roomId, repo);
  }
  return repo;
}

function getTextDbRoomRepository(roomId: string): Repository {
  let repo = textRepositories.get(roomId);
  if (!repo) {
    const rawRepo = new InMemoryTextRepository(roomId);
    repo = new BufferedRepository(rawRepo, { flushIntervalMs: 1000, batchSize: 5 });
    textRepositories.set(roomId, repo);
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
          handleWebSocket(webSocket.raw, roomId, roomRepository, { pubSub }).catch((err) => {
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

  app.get(
    "/ws-text",
    upgradeWebSocket((c) => {
      const roomId = c.req.query("room") || "default";
      const roomRepository = getTextDbRoomRepository(roomId);
      return {
        onOpen: (_evt, webSocket) => {
          if (!webSocket.raw) {
            console.error("WebSocket is undefined");
            return;
          }
          handleWebSocket(webSocket.raw, roomId, roomRepository, { pubSub }).catch((err) => {
            console.error("WebSocket handling error:", err);
          });
        },
      };
    }),
  );

  app.get("/reset-text", async (c) => {
    const roomId = c.req.query("room") || "default";
    const roomRepository = getTextDbRoomRepository(roomId);
    await resetServer(roomRepository);
    console.log(`Text-DB state and database reset for room ${roomId}`);
    return c.text(`Text-DB state and database reset for room ${roomId}`);
  });

  // Serve static files AFTER the WebSocket routes
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

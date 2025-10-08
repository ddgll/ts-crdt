import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { CrdtEvent, Doc } from "@ddgll/ts-crdt";
import type { WebSocket } from "ws";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "./db/schema.js";

interface WebSocketWithId extends WebSocket {
  id: string;
}

const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

let doc: Doc;
let sockets = new Map<string, WebSocketWithId>();

const db = drizzle(createClient({ url: "file:sqlite.db" }), { schema });

async function initializeServer() {
  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");

  doc = new Doc();
  const initialEvents: CrdtEvent[] = await db.query.events.findMany();
  if (initialEvents.length > 0) {
    console.log(`Loading ${initialEvents.length} events from the database.`);
    initialEvents.forEach((e) => {
      doc.egWalker.integrateRemote([e]);
    });
  } else {
    console.log("No existing events. Initializing new document.");
    const event = doc.localInsert(["content"], 0, []);
    await db.insert(schema.events).values(event);
  }

  app.get(
    "/ws",
    upgradeWebSocket(() => {
      return {
        onOpen: (_evt, webSocket) => {
          if (!webSocket.raw) {
            console.error("WebSocket is undefined");
            return;
          }

          const clientId = crypto.randomUUID();
          const wsWithId = Object.assign(webSocket.raw, { id: clientId });

          console.log(`Client ${clientId} connected`);
          sockets.set(clientId, wsWithId);
          console.log(`Total clients: ${sockets.size}`);

          const snapshot = doc.egWalker.getStateSnapshot();
          webSocket.send(JSON.stringify({ type: "snapshot", data: snapshot }));
        },
        onMessage: async (evt, webSocket) => {
          if (!webSocket.raw) {
            console.error("WebSocket is undefined");
            return;
          }
          const clientId = (webSocket.raw as WebSocketWithId).id;
          console.log(`Message received from client ${clientId}`);
          if (typeof evt.data !== "string") {
            console.error("Received non-string message:", evt.data);
            return;
          }

          const event: CrdtEvent = JSON.parse(evt.data);
          console.log("Parsed event:", JSON.stringify(event, null, 2));

          // Persist the event to the database first
          await db.insert(schema.events).values(event);

          doc.egWalker.integrateRemote([event]);

          console.log(`Broadcasting event to ${sockets.size} clients.`);
          for (const socket of sockets.values()) {
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: "event", data: event }));
            }
          }
        },
        onClose: (_evt, webSocket) => {
          const clientId = (webSocket.raw as WebSocketWithId).id;
          console.log(`Client ${clientId} disconnected`);
          sockets.delete(clientId);
          console.log(`Total clients: ${sockets.size}`);
        },
        onError: (err, webSocket) => {
          const clientId = (webSocket.raw as WebSocketWithId).id;
          console.error(`WebSocket error from client ${clientId}:`, err);
          sockets.delete(clientId);
          console.log(`Total clients: ${sockets.size}`);
        },
      };
    }),
  );

  app.get("/reset", async (c) => {
    // Clear the database
    await db.delete(schema.events);
    // Reset in-memory state
    doc = new Doc();
    const event = doc.localInsert(["content"], 0, []);
    await db.insert(schema.events).values(event);
    sockets = new Map<string, WebSocketWithId>();
    console.log("State and database reset");
    return c.text("State and database reset");
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

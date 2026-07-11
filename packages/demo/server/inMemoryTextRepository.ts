import { Repository } from "@ddgll/ts-crdt/server";
import { Doc, CrdtEvent } from "@ddgll/ts-crdt";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import * as schema from "./db/schema.js";

export class InMemoryTextRepository implements Repository {
  private roomId: string;
  // Note: This repository maintains its own Doc instance to integrate events independently 
  // from the CrdtServer's doc. Both process the same events, doubling memory and CPU usage.
  // This duplication is a known trade-off for simplicity in this demo.
  private doc: Doc;
  private initialized = false;

  constructor(roomId: string) {
    this.roomId = roomId;
    this.doc = new Doc("server-" + roomId);
  }

  async getEvents(): Promise<CrdtEvent[]> {
    if (this.initialized) {
      return this.doc.egWalker.graph.getAllEvents();
    }

    const rows = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.roomId, this.roomId));
    
    const row = rows[0];

    if (row && row.content !== null) {
      const textArray = row.content.split("");
      this.doc.getMap().getArray("content").insert(0, textArray);
    } else {
      this.doc.getMap().getArray("content").insert(0, []);
    }

    this.initialized = true;
    return this.doc.egWalker.graph.getAllEvents();
  }

  async saveEvents(events: CrdtEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (!this.initialized) {
      await this.getEvents();
    }

    this.doc.egWalker.integrateRemote(events);

    const content = this.doc.getMap().getArray("content");
    const text = content ? content.toJSON().join("") : "";

    await db
      .insert(schema.documents)
      .values({
        roomId: this.roomId,
        content: text,
      })
      .onConflictDoUpdate({
        target: schema.documents.roomId,
        set: { content: text },
      });
  }

  async clearEvents(): Promise<void> {
    this.doc = new Doc("server-" + this.roomId);
    this.initialized = true;
    await db
      .delete(schema.documents)
      .where(eq(schema.documents.roomId, this.roomId));
  }
}

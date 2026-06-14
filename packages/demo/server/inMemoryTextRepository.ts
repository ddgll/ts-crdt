import { Repository } from "@ddgll/ts-crdt/server";
import { Doc, CrdtEvent } from "@ddgll/ts-crdt";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import * as schema from "./db/schema.js";

export class InMemoryTextRepository implements Repository {
  private roomId: string;
  private doc: Doc;
  private initialized = false;

  constructor(roomId: string) {
    this.roomId = roomId;
    this.doc = new Doc("server-" + roomId);
  }

  async getEvents(): Promise<CrdtEvent[]> {
    if (this.initialized) {
      return Array.from(this.doc.egWalker.graph.events.values());
    }

    const rows = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.roomId, this.roomId));
    
    const row = rows[0];

    if (row && row.content !== null) {
      const textArray = row.content.split("");
      this.doc.localInsert(["content"], 0, textArray);
    } else {
      this.doc.localInsert(["content"], 0, []);
    }

    this.initialized = true;
    return Array.from(this.doc.egWalker.graph.events.values());
  }

  async saveEvent(event: CrdtEvent): Promise<void> {
    if (!this.initialized) {
      await this.getEvents();
    }

    this.doc.egWalker.integrateRemote([event]);

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

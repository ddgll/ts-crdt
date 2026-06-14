import { Repository } from "@ddgll/ts-crdt/server";
import { CrdtEvent } from "@ddgll/ts-crdt";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import * as schema from "./db/schema.js";

export class SqliteRoomRepository implements Repository {
  constructor(private roomId: string) {}

  async getEvents(): Promise<CrdtEvent[]> {
    return await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.roomId, this.roomId));
  }

  async saveEvent(event: CrdtEvent): Promise<void> {
    await db.insert(schema.events).values({
      id: event.id,
      roomId: this.roomId,
      replicaId: event.replicaId,
      parents: event.parents,
      op: event.op,
    });
  }

  async clearEvents(): Promise<void> {
    await db.delete(schema.events).where(eq(schema.events.roomId, this.roomId));
  }
}

import { Repository } from "@ddgll/ts-crdt/server";
import { CrdtEvent } from "@ddgll/ts-crdt";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import * as schema from "./db/schema.js";

export class SqliteRoomRepository implements Repository {
  constructor(private roomId: string) {}

  async getEvents(): Promise<CrdtEvent[]> {
    const rows = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.roomId, this.roomId));
      
    const events: CrdtEvent[] = [];
    for (const row of rows) {
      const { roomId: _, ...eventData } = row;
      if (isCrdtEvent(eventData)) {
        events.push(eventData);
      } else {
        console.warn(`Skipping invalid event from DB: ${row.id}`);
      }
    }
    return events;
  }

  async saveEvents(events: CrdtEvent[]): Promise<void> {
    if (events.length === 0) return;
    await db
      .insert(schema.events)
      .values(
        events.map((event) => ({
          id: event.id,
          roomId: this.roomId,
          replicaId: event.replicaId,
          parents: event.parents,
          op: event.op,
        }))
      )
      .onConflictDoNothing();
  }

  async clearEvents(): Promise<void> {
    await db.delete(schema.events).where(eq(schema.events.roomId, this.roomId));
  }
}

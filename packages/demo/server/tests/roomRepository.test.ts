import { describe, it, expect } from "vitest";
import { SqliteRoomRepository } from "../roomRepository.js";
import { db } from "../db.js";
import * as schema from "../db/schema.js";
import { eq } from "drizzle-orm";

describe("SqliteRoomRepository", () => {
  it("should validate and filter loaded events via getEvents", async () => {
    const roomId = "test-room-valid";
    const repo = new SqliteRoomRepository(roomId);

    await repo.clearEvents();

    const validEvent = {
      id: "replica1:1",
      replicaId: "replica1",
      parents: [],
      op: { type: "map-set", path: [], key: "test", value: 123 },
    };

    await repo.saveEvents([validEvent as unknown as import("@ddgll/ts-crdt").CrdtEvent]);

    // Insert an invalid event directly into DB using Drizzle
    await db.insert(schema.events).values([
      {
        id: "invalid-event-id",
        roomId,
        replicaId: "fake-replica",
        parents: "not-an-array" as unknown as string[], // Invalid JSON structure
        op: "not-an-object" as unknown as import("@ddgll/ts-crdt").Op,
      }
    ]);

    const loadedEvents = await repo.getEvents();

    // Should only return the valid event, filtering out the malformed one
    expect(loadedEvents.length).toBe(1);
    expect(loadedEvents[0].id).toBe("replica1:1");
  });
});

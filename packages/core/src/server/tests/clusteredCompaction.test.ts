import { describe, it, expect } from "vitest";
import { Doc } from "../../crdtTypes/doc.js";
import { CrdtServer, Repository, MinimalWebSocket } from "../crdtServer.js";
import { InMemoryPubSubAdapter } from "../pubSubAdapter.js";
import { CrdtEvent, SNAPSHOT_OP } from "../../index.js";

/**
 * Regression test for PLAN_08 — compaction & server-minted event ids must be
 * cluster-safe. Two CrdtServer instances share one repository and one
 * InMemoryPubSubAdapter. When one compacts it (a) mints a process-unique
 * snapshot id (no cross-process collision → no silent divergence) and (b)
 * publishes the snapshot so the peer rebuilds from it, leaving the shared repo
 * replayable.
 */
describe("Clustered compaction over pub/sub", () => {
  /**
   * A mock socket that mirrors the server's snapshot/event broadcasts into a
   * bound client Doc, so the client stays in sync and can build new events on
   * top of the server's (possibly compacted) state.
   */
  function makeClient(clientDoc: Doc) {
    let messageCallback: (data: string) => void = () => {};
    const socket = {
      readyState: 1,
      send: (msgString: string) => {
        const msg = JSON.parse(msgString);
        if (msg.type === "snapshot") {
          clientDoc.egWalker.loadStateSnapshot(msg.data);
        } else if (msg.type === "event") {
          if (!clientDoc.egWalker.graph.getEvent(msg.data.id)) {
            clientDoc.egWalker.integrateRemote([msg.data]);
          }
        }
      },
      on: (event: string, cb: (data: string) => void) => {
        if (event === "message") messageCallback = cb;
      },
    } as unknown as MinimalWebSocket;

    return {
      socket,
      doc: clientDoc,
      send: (message: unknown) => messageCallback(JSON.stringify(message)),
    };
  }

  const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

  it("keeps two servers converged and the repository replayable when one compacts", async () => {
    // One repository shared by the whole cluster.
    let stored: CrdtEvent[] = [];
    const repo: Repository = {
      getEvents: async () => [...stored],
      saveEvents: async (events) => {
        stored.push(...events);
      },
      clearEvents: async () => {
        stored = [];
      },
    };

    const pubSub = new InMemoryPubSubAdapter();

    // Only serverA compacts (it has the threshold). serverB serves the same
    // room and must converge purely from what it receives over pub/sub.
    const serverA = new CrdtServer("cluster-room", repo, { pubSub, compactionThreshold: 3 });
    await serverA.initialize();
    const serverB = new CrdtServer("cluster-room", repo, { pubSub });
    await serverB.initialize();

    const clientA = makeClient(new Doc("client-A"));
    await serverA.handleConnection(clientA.socket);
    const clientB = makeClient(new Doc("client-B"));
    await serverB.handleConnection(clientB.socket);

    // clientA drives edits into serverA. Each set becomes one event that
    // serverA persists + publishes; serverB integrates it from pub/sub. The
    // 3rd event trips compaction on serverA.
    for (let i = 1; i <= 5; i++) {
      const before = clientA.doc.egWalker.getVersion();
      clientA.doc.getMap().set(`key${i}`, `val${i}`);
      const delta = clientA.doc.egWalker.graph.getChangesSince(before);
      for (const event of delta) {
        clientA.send({ type: "event", data: event });
      }
      await tick();
    }

    // Let background compaction I/O and pub/sub delivery settle.
    await tick(50);
    const compactionPromise = (serverA as unknown as { compactionPromise: Promise<void> | null })
      .compactionPromise;
    if (compactionPromise) await compactionPromise;
    await tick(30);

    // 1. serverA actually compacted: exactly one snapshot root remains.
    const snapshotEvents = serverA
      .getDoc()
      .egWalker.graph.getAllEvents()
      .filter((e) => e.op.type === SNAPSHOT_OP);
    expect(snapshotEvents.length).toBe(1);
    const snapshotId = snapshotEvents[0].id;

    // The snapshot id is process-unique (carries a per-instance suffix), not the
    // colliding `server-cluster-room:0` the old code minted on every process.
    expect(snapshotId.startsWith("server-cluster-room-")).toBe(true);
    expect(snapshotId).not.toBe("server-cluster-room:0");

    // 2. serverB rebuilt from the SAME snapshot event id (proves no silent
    //    divergence via colliding ids) and both docs converge.
    expect(serverB.getDoc().egWalker.graph.getEvent(snapshotId)).toBeDefined();
    for (let i = 1; i <= 5; i++) {
      expect(serverA.getDoc().getMap().get(`key${i}`)).toBe(`val${i}`);
      expect(serverB.getDoc().getMap().get(`key${i}`)).toBe(`val${i}`);
    }
    expect(JSON.stringify(serverB.getDoc().getSnapshot())).toBe(
      JSON.stringify(serverA.getDoc().getSnapshot())
    );

    // 3. The shared repository stays replayable: a fresh process rebuilds the
    //    exact same document from what is persisted (snapshot + post-snapshot
    //    events, all parents present).
    const serverC = new CrdtServer("cluster-room", repo);
    await serverC.initialize();
    for (let i = 1; i <= 5; i++) {
      expect(serverC.getDoc().getMap().get(`key${i}`)).toBe(`val${i}`);
    }
    expect(JSON.stringify(serverC.getDoc().getSnapshot())).toBe(
      JSON.stringify(serverA.getDoc().getSnapshot())
    );
  });

  it("mints process-unique snapshot replica ids across instances of the same room", async () => {
    // Two independent single-process rooms (no shared repo) compacting the same
    // logical content must still mint different snapshot ids — the property that
    // makes clustered compaction safe.
    const makeRepo = (): Repository => {
      let stored: CrdtEvent[] = [];
      return {
        getEvents: async () => [...stored],
        saveEvents: async (events) => {
          stored.push(...events);
        },
        clearEvents: async () => {
          stored = [];
        },
      };
    };

    const snapshotIdFor = async (server: CrdtServer) => {
      server.getDoc().getMap().set("k", "v");
      await server.compact();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const snap = server
        .getDoc()
        .egWalker.graph.getAllEvents()
        .find((e) => e.op.type === SNAPSHOT_OP);
      return snap?.id;
    };

    const serverA = new CrdtServer("same-room", makeRepo());
    await serverA.initialize();
    const serverB = new CrdtServer("same-room", makeRepo());
    await serverB.initialize();

    const idA = await snapshotIdFor(serverA);
    const idB = await snapshotIdFor(serverB);

    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);
  });
});

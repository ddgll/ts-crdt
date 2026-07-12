import { describe, it, expect } from "vitest";
import { CrdtServer, Repository, MinimalWebSocket } from "../crdtServer.js";
import { InMemoryPubSubAdapter } from "../pubSubAdapter.js";
import { CrdtEvent, Doc, MAP_SET_OP } from "../../index.js";

/**
 * Regression tests for PLAN_03: the server must never persist an event it could
 * not integrate, must tolerate out-of-order / missing-parent delivery without
 * throwing, and must recover a persisted orphan on reload instead of bricking.
 */

class MockRepository implements Repository {
	events: CrdtEvent[] = [];
	saveEventsCalls = 0;

	async getEvents(): Promise<CrdtEvent[]> {
		return this.events;
	}

	async saveEvents(events: CrdtEvent[]): Promise<void> {
		this.saveEventsCalls++;
		this.events.push(...events);
	}

	async clearEvents(): Promise<void> {
		this.events = [];
	}
}

class MockWebSocket implements MinimalWebSocket {
	sentData: string[] = [];
	readyState = 1; // OPEN

	private messageListeners: ((data: unknown) => void)[] = [];
	private closeListeners: (() => void)[] = [];
	private errorListeners: ((err: unknown) => void)[] = [];

	send(data: string): void {
		this.sentData.push(data);
	}

	close(): void {
		this.readyState = 3;
		this.emit("close");
	}

	on(event: "message", cb: (data: unknown) => void): void;
	on(event: "close", cb: () => void): void;
	on(event: "error", cb: (err: unknown) => void): void;
	on(event: "message" | "close" | "error", cb: unknown): void {
		if (event === "message") this.messageListeners.push(cb as (data: unknown) => void);
		else if (event === "close") this.closeListeners.push(cb as () => void);
		else if (event === "error") this.errorListeners.push(cb as (err: unknown) => void);
	}

	emit(event: "message", data: unknown): void;
	emit(event: "close"): void;
	emit(event: "message" | "close", data?: unknown): void {
		if (event === "message") this.messageListeners.forEach((cb) => cb(data));
		else if (event === "close") this.closeListeners.forEach((cb) => cb());
	}
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Server durability (PLAN_03)", () => {
	it("integrates a child event received before its parent, once the parent arrives", async () => {
		const repo = new MockRepository();
		const server = new CrdtServer("child-first-room", repo);
		await server.initialize();

		const ws = new MockWebSocket();
		await server.handleConnection(ws);

		// Build a parent → child chain on a client synced to the server state.
		const client = new Doc("client-1");
		client.egWalker.integrateRemote(server.getDoc().egWalker.graph.getAllEvents());
		const parentEvent = client.getMap().set("x", 1);
		const childEvent = client.getMap().set("y", 2); // parents: [parentEvent.id]

		// Deliver the child FIRST (out of order).
		ws.emit("message", JSON.stringify(childEvent));
		await tick();

		// The child must be buffered — not applied and not persisted.
		expect(server.getDoc().getMap().get("y")).toBeUndefined();
		expect(server.getDoc().egWalker.getPendingEventCount()).toBe(1);
		const repoLenBeforeParent = repo.events.length;
		expect(repo.events.some((e) => e.id === childEvent.id)).toBe(false);

		// Now deliver the parent → both integrate and both get persisted.
		ws.emit("message", JSON.stringify(parentEvent));
		await tick();

		expect(server.getDoc().getMap().get("x")).toBe(1);
		expect(server.getDoc().getMap().get("y")).toBe(2);
		expect(server.getDoc().egWalker.getPendingEventCount()).toBe(0);
		expect(repo.events.length).toBe(repoLenBeforeParent + 2);
		expect(repo.events.some((e) => e.id === parentEvent.id)).toBe(true);
		expect(repo.events.some((e) => e.id === childEvent.id)).toBe(true);

		// Reload: disconnect everyone, reconnect → state recovers from the repo.
		ws.emit("close");
		await tick();
		const ws2 = new MockWebSocket();
		await server.handleConnection(ws2);
		await tick();

		expect(server.getDoc().getMap().get("x")).toBe(1);
		expect(server.getDoc().getMap().get("y")).toBe(2);
	});

	it("initialize() does not throw and recovers when the repository contains an orphan event", async () => {
		// Seed a valid history from a throwaway doc.
		const seedDoc = new Doc("seed");
		seedDoc.getMap().getArray("content").insert(0, ["hello"]);
		const seedEvents = seedDoc.egWalker
			.getStateSnapshot()
			.graph.events.map(([, e]) => e);

		// A persisted orphan whose parent will never be found.
		const orphan: CrdtEvent = {
			id: "ghostwriter:5",
			replicaId: "ghostwriter",
			parents: ["missing:1"],
			op: { type: MAP_SET_OP, path: [], key: "orphanKey", value: "orphanVal" },
		};

		const repo = new MockRepository();
		repo.events = [...seedEvents, orphan];

		const server = new CrdtServer("orphan-repo-room", repo);
		// Must not throw / brick the room.
		await server.initialize();

		// Valid state is recovered; the orphan is buffered, not applied.
		expect(server.getDoc().getMap().getArray("content").toJSON()).toEqual(["hello"]);
		expect(server.getDoc().getMap().get("orphanKey")).toBeUndefined();
		expect(server.getDoc().egWalker.getPendingEventCount()).toBe(1);

		// A live connection still works after recovery.
		const ws = new MockWebSocket();
		await server.handleConnection(ws);
		expect(ws.sentData.length).toBeGreaterThan(0); // received a snapshot
	});

	it("recovers even when the orphan precedes its dependency in repository order", async () => {
		// Build a chain, then persist it out of causal order (child before parent).
		const seedDoc = new Doc("seed");
		const parent = seedDoc.getMap().set("a", 1);
		const child = seedDoc.getMap().set("b", 2);

		const repo = new MockRepository();
		repo.events = [child, parent]; // deliberately reversed

		const server = new CrdtServer("reordered-repo-room", repo);
		await server.initialize();

		expect(server.getDoc().getMap().get("a")).toBe(1);
		expect(server.getDoc().getMap().get("b")).toBe(2);
		expect(server.getDoc().egWalker.getPendingEventCount()).toBe(0);
	});

	it("converges across two pubSub instances despite child-first (reordered) delivery", async () => {
		const pubSub = new InMemoryPubSubAdapter();
		// A clustered room shares persistence, so both instances load the same
		// seed root (rather than each seeding a divergent one).
		const repo = new MockRepository();
		const server1 = new CrdtServer("cluster-room", repo, { pubSub });
		const server2 = new CrdtServer("cluster-room", repo, { pubSub });
		await server1.initialize();
		await server2.initialize();

		const ws1 = new MockWebSocket();
		await server1.handleConnection(ws1);

		// Client builds a parent → child chain synced to server1's state.
		const client = new Doc("client-1");
		client.egWalker.integrateRemote(server1.getDoc().egWalker.graph.getAllEvents());
		const parentEvent = client.getMap().set("x", 10);
		const childEvent = client.getMap().set("y", 20);

		// Deliver child first, then parent — exercising orphan buffering on both
		// the receiving instance and the peer instance (via pubSub).
		ws1.emit("message", JSON.stringify(childEvent));
		await tick();
		ws1.emit("message", JSON.stringify(parentEvent));
		await tick(50);

		// Both instances converge to the same state.
		expect(server1.getDoc().getMap().get("x")).toBe(10);
		expect(server1.getDoc().getMap().get("y")).toBe(20);
		expect(server2.getDoc().getMap().get("x")).toBe(10);
		expect(server2.getDoc().getMap().get("y")).toBe(20);
		expect(server1.getDoc().egWalker.getPendingEventCount()).toBe(0);
		expect(server2.getDoc().egWalker.getPendingEventCount()).toBe(0);
	});
});

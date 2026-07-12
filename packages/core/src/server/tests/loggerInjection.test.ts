import { describe, it, expect, afterEach } from "vitest";
import { CrdtServer, MinimalWebSocket, Repository } from "../crdtServer.js";
import { CrdtEvent, Doc } from "../../index.js";
import { Logger, setLogger, consoleLogger } from "../../logger.js";

class CapturingLogger implements Logger {
	entries: { level: string; args: unknown[] }[] = [];
	debug(...args: unknown[]) { this.entries.push({ level: "debug", args }); }
	info(...args: unknown[]) { this.entries.push({ level: "info", args }); }
	warn(...args: unknown[]) { this.entries.push({ level: "warn", args }); }
	error(...args: unknown[]) { this.entries.push({ level: "error", args }); }
}

class MockRepository implements Repository {
	events: CrdtEvent[] = [];
	failSaves = false;
	async getEvents() { return this.events; }
	async saveEvents(events: CrdtEvent[]) {
		if (this.failSaves) throw new Error("simulated save failure");
		this.events.push(...events);
	}
	async clearEvents() { this.events = []; }
}

class MockWebSocket implements MinimalWebSocket {
	sentData: string[] = [];
	readyState = 1;
	private messageListeners: ((data: unknown) => void)[] = [];
	private closeListeners: (() => void)[] = [];
	private errorListeners: ((err: unknown) => void)[] = [];
	send(data: string) { this.sentData.push(data); }
	close() { this.readyState = 3; }
	on(event: "message" | "close" | "error", cb: unknown) {
		if (event === "message") this.messageListeners.push(cb as (d: unknown) => void);
		else if (event === "close") this.closeListeners.push(cb as () => void);
		else this.errorListeners.push(cb as (e: unknown) => void);
	}
	emit(event: "message", data: unknown): void;
	emit(event: "close"): void;
	emit(event: "message" | "close", arg?: unknown) {
		if (event === "message") this.messageListeners.forEach((cb) => cb(arg));
		else this.closeListeners.forEach((cb) => cb());
	}
}

afterEach(() => {
	// Restore the process-wide logger after tests that override it.
	setLogger(consoleLogger);
});

describe("PLAN_07.5 — injectable logger", () => {
	it("routes EgWalker diagnostics through the process-wide logger", () => {
		const logger = new CapturingLogger();
		setLogger(logger);

		const doc = new Doc("replica-x");
		// A throwing listener is caught and reported via the logger.
		doc.egWalker.onEvent(() => {
			throw new Error("listener boom");
		});
		doc.getMap().set("k", "v");

		const errors = logger.entries.filter((e) => e.level === "error");
		expect(errors.length).toBeGreaterThan(0);
		expect(String(errors[0].args[0])).toContain("[EgWalker]");
	});

	it("uses a per-server logger passed in options for warnings", async () => {
		const logger = new CapturingLogger();
		const repo = new MockRepository();
		const server = new CrdtServer("logger-room", repo, { logger });
		await server.initialize();

		const ws = new MockWebSocket();
		await server.handleConnection(ws);

		// Malformed event id → server rejects via this.logger.warn.
		ws.emit("message", JSON.stringify({
			id: "not-valid",
			replicaId: "c1",
			parents: [],
			op: { type: "map-set", path: [], key: "k", value: "v" },
		}));
		await new Promise((r) => setTimeout(r, 10));

		const warns = logger.entries.filter((e) => e.level === "warn");
		expect(warns.some((w) => String(w.args[0]).includes("Rejected invalid event"))).toBe(true);
	});
});

describe("PLAN_07.5 — onError hook surfaces dropped work", () => {
	it("invokes onError when a queued task fails (e.g. persistence error)", async () => {
		const errors: { context: string; error: unknown }[] = [];
		const repo = new MockRepository();
		const server = new CrdtServer("onerror-room", repo, {
			onError: (context, error) => errors.push({ context, error }),
		});
		await server.initialize();

		const ws = new MockWebSocket();
		await server.handleConnection(ws);

		// Build a valid client event referencing the server's current state.
		const clientDoc = new Doc("client-1");
		clientDoc.egWalker.integrateRemote(server.getDoc().egWalker.graph.getAllEvents());
		clientDoc.getMap().getArray("content").insert(0, ["z"]);
		const evs = clientDoc.egWalker.getStateSnapshot().graph.events;
		const clientEvent = evs[evs.length - 1][1];

		// Make persistence fail so the message task throws.
		repo.failSaves = true;
		ws.emit("message", JSON.stringify(clientEvent));
		await new Promise((r) => setTimeout(r, 10));

		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0].context).toBe("Error processing message");
	});
});

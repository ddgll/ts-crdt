import { describe, it, expect } from 'vitest';
import { Doc } from "../doc.js";
import { CrdtEvent } from "../../eventGraph/eventGraph.js";

describe("Stress: Multi-writer convergence", () => {
    it("should converge with 10 concurrent writers on YMap", () => {
        const replicas = Array.from({ length: 10 }, (_, i) =>
            new Doc(`replica-${i}`)
        );

        // Each replica sets a different key
        const allEvents: CrdtEvent[] = [];
        for (let i = 0; i < 10; i++) {
            replicas[i].getMap().set(`key-${i}`, `value-${i}`);
            allEvents.push(...replicas[i].egWalker.graph.getAllEvents());
        }

        // Integrate all events into all replicas
        for (const replica of replicas) {
            replica.egWalker.integrateRemote(allEvents);
        }

        // Verify convergence
        const expected = JSON.stringify(replicas[0].getMap().toJSON());
        for (let i = 1; i < 10; i++) {
            expect(JSON.stringify(replicas[i].getMap().toJSON())).toBe(expected);
        }
    });

    it("should converge with 10 concurrent writers on same YMap key", () => {
        const replicas = Array.from({ length: 10 }, (_, i) =>
            new Doc(`replica-${i}`)
        );

        const allEvents: CrdtEvent[] = [];
        for (let i = 0; i < 10; i++) {
            replicas[i].getMap().set(`key`, `value-${i}`);
            allEvents.push(...replicas[i].egWalker.graph.getAllEvents());
        }

        for (const replica of replicas) {
            replica.egWalker.integrateRemote(allEvents);
        }

        const expected = JSON.stringify(replicas[0].getMap().toJSON());
        for (let i = 1; i < 10; i++) {
            expect(JSON.stringify(replicas[i].getMap().toJSON())).toBe(expected);
        }
    });

    it("should converge with 5 concurrent writers on YArray", () => {
        const replicas = Array.from({ length: 5 }, (_, i) =>
            new Doc(`replica-${i}`)
        );

        // All inserting at index 0 initially
        const allEvents: CrdtEvent[] = [];
        for (let i = 0; i < 5; i++) {
            replicas[i].getMap().getArray("arr").insert(0, [`value-${i}`]);
            allEvents.push(...replicas[i].egWalker.graph.getAllEvents());
        }

        for (const replica of replicas) {
            replica.egWalker.integrateRemote(allEvents);
        }

        const expected = JSON.stringify(replicas[0].getMap().toJSON());
        for (let i = 1; i < 5; i++) {
            expect(JSON.stringify(replicas[i].getMap().toJSON())).toBe(expected);
        }
    });

    it("should converge with 5 concurrent writers on YText", () => {
        const replicas = Array.from({ length: 5 }, (_, i) =>
            new Doc(`replica-${i}`)
        );

        const allEvents: CrdtEvent[] = [];
        for (let i = 0; i < 5; i++) {
            replicas[i].getMap().getText("text").insert(0, `A${i}`);
            allEvents.push(...replicas[i].egWalker.graph.getAllEvents());
        }

        for (const replica of replicas) {
            replica.egWalker.integrateRemote(allEvents);
        }

        const expected = JSON.stringify(replicas[0].getMap().toJSON());
        for (let i = 1; i < 5; i++) {
            expect(JSON.stringify(replicas[i].getMap().toJSON())).toBe(expected);
        }
    });
});

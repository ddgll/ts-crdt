import { describe, it, expect } from "vitest";
import { Doc } from "@ddgll/ts-crdt";
import type { CrdtEvent } from "@ddgll/ts-crdt";
import { readJson, applyJson, setPath, deletePath, type JsonObject } from "../jsonCrdt.js";

const ROOT = "doc";

/** Mirrors the real transport: events are JSON-serialized over the WebSocket. */
function wire(events: CrdtEvent[]): CrdtEvent[] {
  return JSON.parse(JSON.stringify(events)) as CrdtEvent[];
}

function newIds(doc: Doc, seen: Set<string>): CrdtEvent[] {
  const fresh = doc.egWalker.graph.getAllEvents().filter((e) => !seen.has(e.id));
  for (const e of fresh) seen.add(e.id);
  return fresh;
}

/** A pair of replicas kept in sync by explicit, wire-serialized exchanges. */
function pair(initial: JsonObject) {
  const a = new Doc("a");
  applyJson(a, ROOT, initial);
  const b = new Doc("b");
  b.egWalker.integrateRemote(wire(a.egWalker.graph.getAllEvents()));

  const seenA = new Set(a.egWalker.graph.getAllEvents().map((e) => e.id));
  const seenB = new Set(b.egWalker.graph.getAllEvents().map((e) => e.id));

  return {
    a,
    b,
    /** Exchanges each replica's new events with the other, both ways. */
    sync() {
      const fromA = newIds(a, seenA);
      const fromB = newIds(b, seenB);
      b.egWalker.integrateRemote(wire(fromA));
      a.egWalker.integrateRemote(wire(fromB));
      for (const e of fromA) seenB.add(e.id);
      for (const e of fromB) seenA.add(e.id);
    },
  };
}

describe("jsonCrdt round-trip", () => {
  it("preserves a document of every JSON shape", () => {
    const source: JsonObject = {
      title: "Quarterly report",
      revision: 7,
      published: false,
      archivedAt: null,
      tags: ["finance", "q3", "draft"],
      scores: [1, 2.5, -3],
      meta: { author: { name: "Ada", email: "ada@example.com" }, wordCount: 1200 },
      sections: [
        { id: "s1", heading: "Intro", body: "Opening remarks.", pinned: true },
        { id: "s2", heading: "Numbers", body: "Revenue grew.", pinned: false },
      ],
      empty: {},
      none: [],
    };

    const doc = new Doc("a");
    applyJson(doc, ROOT, source);
    expect(readJson(doc, ROOT)).toEqual(source);
  });

  it("survives wire serialization to another replica", () => {
    const source: JsonObject = {
      sections: [
        { id: "s1", heading: "Intro", body: "Opening remarks." },
        { id: "s2", heading: "Numbers", body: "Revenue grew." },
      ],
      meta: { author: "Ada", nested: { deep: { deeper: "value" } } },
    };
    const { a, b } = pair(source);
    expect(readJson(b, ROOT)).toEqual(source);
    expect(readJson(b, ROOT)).toEqual(readJson(a, ROOT));
  });

  it("replicates empty objects and arrays", () => {
    // Containers are created without emitting an event, so an empty one has to
    // be materialized deliberately or it never leaves the replica that made it.
    const source: JsonObject = {
      emptyObject: {},
      emptyArray: [],
      nested: { alsoEmpty: {}, alsoEmptyArray: [] },
      records: [{ id: "r1", name: "one", tags: [] }],
    };
    const { a, b } = pair(source);
    expect(readJson(b, ROOT)).toEqual(source);
    expect(readJson(b, ROOT)).toEqual(readJson(a, ROOT));
  });

  it("does not re-emit markers when empty containers are re-applied", () => {
    const source: JsonObject = { emptyObject: {}, emptyArray: [] };
    const doc = new Doc("a");
    applyJson(doc, ROOT, source);
    expect(applyJson(doc, ROOT, source).ops).toBe(0);
    expect(readJson(doc, ROOT)).toEqual(source);
  });

  it("fills and empties a container without losing the key", () => {
    const doc = new Doc("a");
    applyJson(doc, ROOT, { bag: {}, list: [] });
    applyJson(doc, ROOT, { bag: { a: 1 }, list: [1, 2] });
    expect(readJson(doc, ROOT)).toEqual({ bag: { a: 1 }, list: [1, 2] });
    applyJson(doc, ROOT, { bag: {}, list: [] });
    expect(readJson(doc, ROOT)).toEqual({ bag: {}, list: [] });
  });

  it("emits no operations when re-applying identical JSON", () => {
    const source: JsonObject = { a: "x", n: 1, list: [{ id: "1", v: "one" }] };
    const doc = new Doc("a");
    applyJson(doc, ROOT, source);
    const again = applyJson(doc, ROOT, source);
    expect(again.ops).toBe(0);
  });

  it("switches representation when a value changes JSON type", () => {
    const doc = new Doc("a");
    applyJson(doc, ROOT, { field: "a string" });
    applyJson(doc, ROOT, { field: 42 });
    expect(readJson(doc, ROOT)).toEqual({ field: 42 });
    applyJson(doc, ROOT, { field: { now: "an object" } });
    expect(readJson(doc, ROOT)).toEqual({ field: { now: "an object" } });
    applyJson(doc, ROOT, { field: [1, 2, 3] });
    expect(readJson(doc, ROOT)).toEqual({ field: [1, 2, 3] });
    applyJson(doc, ROOT, { field: "back to string" });
    expect(readJson(doc, ROOT)).toEqual({ field: "back to string" });
  });
});

describe("jsonCrdt concurrent merging", () => {
  it("merges edits to different fields of the same object", () => {
    const { a, b, sync } = pair({ user: { first: "Ada", last: "Lovelace", age: 36 } });

    setPath(a, ROOT, ["user", "first"], "Augusta");
    setPath(b, ROOT, ["user", "age"], 37);
    sync();

    const expected = { user: { first: "Augusta", last: "Lovelace", age: 37 } };
    expect(readJson(a, ROOT)).toEqual(expected);
    expect(readJson(b, ROOT)).toEqual(expected);
  });

  it("merges edits to different records of the same array", () => {
    const { a, b, sync } = pair({
      sections: [
        { id: "s1", heading: "Intro", body: "one" },
        { id: "s2", heading: "Body", body: "two" },
        { id: "s3", heading: "Outro", body: "three" },
      ],
    });

    setPath(a, ROOT, ["sections", "ks1", "heading"], "Introduction");
    setPath(b, ROOT, ["sections", "ks3", "body"], "three, revised");
    sync();

    const expected = {
      sections: [
        { id: "s1", heading: "Introduction", body: "one" },
        { id: "s2", heading: "Body", body: "two" },
        { id: "s3", heading: "Outro", body: "three, revised" },
      ],
    };
    expect(readJson(a, ROOT)).toEqual(expected);
    expect(readJson(b, ROOT)).toEqual(expected);
  });

  it("merges concurrent character edits within one string field", () => {
    const { a, b, sync } = pair({ note: "Hello world" });

    // A prepends, B appends — a whole-value LWW store would lose one of these.
    applyJson(a, ROOT, { note: "Oh, Hello world" });
    applyJson(b, ROOT, { note: "Hello world!!!" });
    sync();

    const merged = readJson(a, ROOT).note as string;
    expect(readJson(b, ROOT)).toEqual(readJson(a, ROOT));
    expect(merged).toContain("Oh, ");
    expect(merged).toContain("!!!");
    expect(merged).toContain("Hello world");
  });

  it("keeps both records when two replicas append concurrently", () => {
    const { a, b, sync } = pair({ items: [{ id: "a1", label: "first" }] });

    const fromA = readJson(a, ROOT).items as JsonObject[];
    applyJson(a, ROOT, { items: [...fromA, { id: "a2", label: "from A" }] });
    const fromB = readJson(b, ROOT).items as JsonObject[];
    applyJson(b, ROOT, { items: [...fromB, { id: "b2", label: "from B" }] });
    sync();

    const labels = (readJson(a, ROOT).items as JsonObject[]).map((i) => i.label);
    expect(readJson(b, ROOT)).toEqual(readJson(a, ROOT));
    expect(labels).toContain("from A");
    expect(labels).toContain("from B");
    expect(labels).toContain("first");
  });

  it("targets the intended record when a concurrent insert shifts positions", () => {
    // The positional-path hazard: B edits the last record while A prepends a new
    // one. Identity-keyed storage must land B's edit on the record it named.
    const { a, b, sync } = pair({
      items: [
        { id: "x", v: "X" },
        { id: "y", v: "Y" },
        { id: "z", v: "Z" },
      ],
    });

    const current = readJson(a, ROOT).items as JsonObject[];
    applyJson(a, ROOT, { items: [{ id: "new", v: "NEW" }, ...current] });
    setPath(b, ROOT, ["items", "kz", "v"], "Z-EDITED");
    sync();

    const items = readJson(a, ROOT).items as JsonObject[];
    expect(readJson(b, ROOT)).toEqual(readJson(a, ROOT));
    expect(items.find((i) => i.id === "z")?.v).toBe("Z-EDITED");
    expect(items.find((i) => i.id === "y")?.v).toBe("Y");
    expect(items.find((i) => i.id === "new")?.v).toBe("NEW");
  });

  it("propagates deletions", () => {
    const { a, b, sync } = pair({ keep: "yes", drop: "no", items: [{ id: "1", v: "a" }] });
    deletePath(a, ROOT, ["drop"]);
    sync();
    expect(readJson(b, ROOT)).toEqual({ keep: "yes", items: [{ id: "1", v: "a" }] });
  });
});

describe("jsonCrdt at scale", () => {
  it("round-trips a large document and reconciles a single field cheaply", () => {
    const big: JsonObject = {
      records: Array.from({ length: 300 }, (_, i) => ({
        id: `r${i}`,
        name: `Record number ${i}`,
        description: `A description for record ${i} with enough text to matter.`,
        score: i * 3,
        active: i % 2 === 0,
        tags: [`tag-${i % 7}`, `group-${i % 11}`],
      })),
    };

    const doc = new Doc("a");
    applyJson(doc, ROOT, big);
    expect(readJson(doc, ROOT)).toEqual(big);

    // A one-field change must not rewrite the other 299 records.
    const next = JSON.parse(JSON.stringify(big)) as JsonObject;
    (next.records as JsonObject[])[150].name = "Renamed record";
    const stats = applyJson(doc, ROOT, next);
    expect(stats.ops).toBeLessThanOrEqual(4);
    expect((readJson(doc, ROOT).records as JsonObject[])[150].name).toBe("Renamed record");
  });
});

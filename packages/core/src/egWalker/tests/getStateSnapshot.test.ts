import { describe, it, expect } from 'vitest';
import { Doc } from "../../crdtTypes/doc.js";

describe("EgWalker.getStateSnapshot", () => {
  it("get state snapshot", () => {
    const doc = new Doc();
    const map = doc.getMap();
    map.set("foo", "bar");

    const snapshot = doc.egWalker.getStateSnapshot();
    const newDoc = new Doc();
    newDoc.egWalker.loadStateSnapshot(snapshot);

    expect(newDoc.getMap().get("foo")).toEqual("bar");
  });
});

import { describe, expect, it } from "vitest";
import { Doc } from "../doc.js";

describe("Doc local operations", () => {
  it("should insert values into a YArray", () => {
    const doc = new Doc();
    const items = doc.getMap().getArray("items");
    doc.localInsert(["items"], 0, ["a", "b"]);
    expect(items.toJSON()).toEqual(["a", "b"]);
  });

  it("should delete values from a YArray", () => {
    const doc = new Doc();
    const items = doc.getMap().getArray("items");
    items.insert(0, ["a", "b", "c"]);
    doc.localDelete(["items"], 1, 1);
    expect(items.toJSON()).toEqual(["a", "c"]);
  });
});
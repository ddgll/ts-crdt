import { describe, it, expect } from 'vitest';
import { Doc } from "../doc.js";

describe("Doc local operations", () => {
  it("should insert values into a YArray", () => {
    const doc = new Doc();
    const items = doc.getMap().getArray("items");
    items.insert(0, ["a", "b"]);
    expect(items.toJSON()).toEqual(["a", "b"]);
  });

  it("should delete values from a YArray", () => {
    const doc = new Doc();
    const items = doc.getMap().getArray("items");
    items.insert(0, ["a", "b", "c"]);
    items.delete(1, 1);
    expect(items.toJSON()).toEqual(["a", "c"]);
  });
});
import { Doc } from "../Doc.js";

describe("YArray", () => {
  it("should insert and get elements", () => {
    const doc = new Doc();
    const arr = doc.getMap().getArray("my-array");
    arr.insert(0, ["a", "b", "c"]);
    expect(arr.toJSON()).toEqual(["a", "b", "c"]);
  });

  it("should delete elements", () => {
    const doc = new Doc();
    const arr = doc.getMap().getArray("my-array");
    arr.insert(0, ["a", "b", "c"]);
    arr.delete(1, 1);
    expect(arr.toJSON()).toEqual(["a", "c"]);
  });

  it("should get an element at a specific index", () => {
    const doc = new Doc();
    const arr = doc.getMap().getArray("my-array");
    arr.insert(0, ["a", "b", "c"]);
    expect(arr.get(1)).toEqual("b");
  });
});
import { Doc } from "../../crdtTypes/Doc.js";
import { YArray } from "../../crdtTypes/YArray.js";

test("EgWalker.loadStateSnapshot - load state snapshot", () => {
  const doc1 = new Doc();
  const map1 = doc1.getMap();
  map1.set("foo", "bar");
  const array1 = map1.getArray("items");
  array1.insert(0, ["a", "b"]);

  const snapshot = doc1.egWalker.getStateSnapshot();

  const doc2 = new Doc();
  doc2.egWalker.loadStateSnapshot(snapshot);

  const map2 = doc2.getMap();
  expect(map2.get("foo")).toEqual("bar");

  const array2 = map2.get("items") as YArray;
  expect(array2.get(0)).toEqual("a");
  expect(array2.get(1)).toEqual("b");
});

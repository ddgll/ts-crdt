import { describe, it, expect } from "vitest";
import { Doc } from "../Doc.js";
import { YMap } from "../YMap.js";
import { YArray } from "../YArray.js";

describe("YMap extended coverage", () => {
    it("should throw when getting a map from a non-map key", () => {
        const doc = new Doc();
        const map = doc.getMap();
        map.set("my-key", "not-a-map");
        expect(() => map.getMap("my-key")).toThrow("Type mismatch: expected YMap");
    });

    it("should throw when getting an array from a non-array key", () => {
        const doc = new Doc();
        const map = doc.getMap();
        map.set("my-key", "not-an-array");
        expect(() => map.getArray("my-key")).toThrow("Type mismatch: expected YArray");
    });

    it("should merge another YMap", () => {
        const doc1 = new Doc();
        const map1 = doc1.getMap();
        map1.set("key1", "value1");
        const nestedMap1 = map1.getMap("nested");
        nestedMap1.set("nestedKey1", "nestedValue1");

        const doc2 = new Doc();
        const map2 = doc2.getMap();
        map2.set("key2", "value2");
        const nestedMap2 = map2.getMap("nested");
        nestedMap2.set("nestedKey2", "nestedValue2");

        map1.merge(map2);

        expect(map1.get("key1")).toBe("value1");
        expect(map1.get("key2")).toBe("value2");
        const mergedNestedMap = map1.get("nested") as YMap;
        expect(mergedNestedMap.get("nestedKey1")).toBe("nestedValue1");
        expect(mergedNestedMap.get("nestedKey2")).toBe("nestedValue2");
    });

    it("should overwrite existing keys on merge", () => {
        const doc1 = new Doc();
        const map1 = doc1.getMap();
        map1.set("key1", "value1");

        const doc2 = new Doc();
        const map2 = doc2.getMap();
        map2.set("key1", "newValue");

        map1.merge(map2);

        expect(map1.get("key1")).toBe("newValue");
    });

    it("should handle non-YMap values during merge", () => {
        const doc1 = new Doc();
        const map1 = doc1.getMap();
        const nestedMap = map1.getMap("nested");
        nestedMap.set("a", "b");

        const doc2 = new Doc();
        const map2 = doc2.getMap();
        map2.set("nested", "not-a-map");

        map1.merge(map2);

        expect(map1.get("nested")).toBe("not-a-map");
    });

    it("should create a new YMap if one does not exist", () => {
        const doc = new Doc();
        const map = doc.getMap();
        const newMap = map.getMap("new-map");
        expect(newMap).toBeInstanceOf(YMap);
        expect(map.get("new-map")).toBe(newMap);
    });

    it("should create a new YArray if one does not exist", () => {
        const doc = new Doc();
        const map = doc.getMap();
        const newArray = map.getArray("new-array");
        expect(newArray).toBeInstanceOf(YArray);
        expect(map.get("new-array")).toBe(newArray);
    });
});
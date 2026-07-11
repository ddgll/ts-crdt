import { describe, it, expect } from 'vitest';
import { Doc } from "../doc.js";
import { YMap } from "../yMap.js";
import { YArray } from "../yArray.js";

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
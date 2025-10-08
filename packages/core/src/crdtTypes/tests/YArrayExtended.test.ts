import { describe, it, expect } from "vitest";
import { Doc } from "../Doc.js";
import { YArray } from "../YArray.js";
import { YMap } from "../YMap.js";

describe("YArray extended coverage", () => {
    it("should replace all elements", () => {
        const doc = new Doc();
        const arr = doc.getMap().getArray("my-array");
        arr.insert(0, ["a", "b", "c"]);
        arr.replace(["d", "e"]);
        expect(arr.toJSON()).toEqual(["d", "e"]);
    });

    it("should create a YArray from a JSON object with primitives", () => {
        const doc = new Doc();
        const json = ["a", 1, true];
        const arr = YArray.fromJSON(doc, ["my-array"], json);
        expect(arr.toJSON()).toEqual(json);
    });

    it("should create a YArray from a JSON object with a nested YMap", () => {
        const doc = new Doc();
        const json = [
            {
                crdtType: "YMap",
                data: {
                    key: "value"
                }
            }
        ];
        const arr = YArray.fromJSON(doc, ["my-array"], json);
        const map = arr.get(0) as YMap;
        expect(map instanceof YMap).toBe(true);
        expect(map.get("key")).toBe("value");
    });

    it("should create a YArray from a JSON object with a nested YArray", () => {
        const doc = new Doc();
        const json = [
            {
                crdtType: "YArray",
                data: ["nested"]
            }
        ];
        const arr = YArray.fromJSON(doc, ["my-array"], json);
        const nestedArr = arr.get(0) as YArray;
        expect(nestedArr instanceof YArray).toBe(true);
        expect(nestedArr.get(0)).toBe("nested");
    });

    it("should handle mixed content in fromJSON", () => {
        const doc = new Doc();
        const json = [
            "primitive",
            {
                crdtType: "YMap",
                data: { key: "value" }
            }
        ];
        const arr = YArray.fromJSON(doc, ["my-array"], json);
        expect(arr.get(0)).toBe("primitive");
        const map = arr.get(1) as YMap;
        expect(map instanceof YMap).toBe(true);
        expect(map.get("key")).toBe("value");
    });

    it("should handle non-crdt objects in fromJSON", () => {
        const doc = new Doc();
        const json = [{ not: "a crdt" }];
        const arr = YArray.fromJSON(doc, ["my-array"], json);
        expect(arr.toJSON()).toEqual(json);
    });

    it("should serialize to JSON with nested CRDTs", () => {
        const doc = new Doc();
        const json = [
            {
                crdtType: "YMap",
                data: { key: "value" }
            },
            {
                crdtType: "YArray",
                data: ["nested"]
            }
        ];
        const arr = YArray.fromJSON(doc, ["my-array"], json);
        expect(arr.toJSON()).toEqual(json);
    });
});
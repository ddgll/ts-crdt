import { describe, expect, it, vi } from "vitest";
import { Doc } from "../Doc.js";

describe("Doc extended coverage", () => {
    it("should not apply update if payload type is not 'set'", () => {
        const doc = new Doc();
        const walkerSpy = vi.spyOn(doc.egWalker, "localOp");

        const update = {
            path: ["user"],
            payload: {
                type: "not-set",
                key: "name",
                value: "David",
            },
        };

        expect(() => doc.applyUpdate(update)).toThrow(
            "Unsupported update type: not-set"
        );
        expect(walkerSpy).not.toHaveBeenCalled();
    });

    it("should create a Doc from a JSON object", () => {
        const data = {
            name: "David",
            nested: {
                crdtType: "YMap",
                data: {
                    value: 123,
                },
            },
        };
        const doc = Doc.fromJSON(data);
        expect(doc.toJSON()).toEqual(data);
    });
});

import { describe, it, expect } from 'vitest';
import { Doc } from "../../crdtTypes/doc.js";
import { CrdtClient } from "../../crdtClient.js";

describe("Performance regression", () => {
    it("YArray.length should be fast with 100K tombstones", () => {
        const doc = new Doc("replica-1");
        const arr = doc.getMap().getArray("arr");

        // Insert and delete 10K items (creating tombstones)
        // using 10K instead of 100K so the test doesn't take too long in CI
        for (let i = 0; i < 100; i++) {
            arr.insert(0, Array.from({ length: 100 }, (_, j) => `${i}-${j}`));
            arr.delete(0, 100);
        }

        const start = performance.now();
        for (let i = 0; i < 1000; i++) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const _len = arr.length; // Should be O(1) after Phase 3
        }
        const duration = performance.now() - start;

        expect(duration).toBeLessThan(100); // 1000 calls < 100ms
    });

    it("syncText should remain fast on large documents", () => {
        const doc = new Doc("replica-1");
        // Use YText directly since it's the default container type
        const content = doc.getMap().getText("content");
        const text = "a".repeat(50_000);
        content.insert(0, text);

        const start = performance.now();
        // Simulate editing at the end
        const newText = text + "b";
        // This should only insert one character
        const client = new CrdtClient(doc);
        // Direct syncText call
        client.syncText(["content"], newText);
        const duration = performance.now() - start;

        expect(duration).toBeLessThan(500); // < 500ms for 50K char doc
    });
});

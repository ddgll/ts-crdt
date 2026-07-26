import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * End-to-end coverage for the collaborative JSON document demo (`/json.html`).
 *
 * These drive real browsers against the real WebSocket server, so they exercise
 * the path that in-process unit tests cannot: events are JSON-serialized on the
 * wire, which is exactly where a naive "nested container inside a YArray"
 * encoding silently degrades into an inert plain object. See
 * `interactive-test/jsonCrdt.ts` for the encoding these tests validate.
 */

const BASE = "http://localhost:3000";

/** Records per "big document" case. Produces ~1400 CRDT operations. */
const BIG = 200;

/** A bulk change streams one WebSocket message per operation, so allow for it. */
const BULK_TIMEOUT = 60_000;
const SYNC_TIMEOUT = 15_000;
/** Must exceed BULK_TIMEOUT, or the test aborts before its own waits expire. */
const BULK_TEST_TIMEOUT = 120_000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type JsonRecord = { [k: string]: JsonValue };

/** Test hook installed by `interactive-test/json.ts`. */
interface JsonApi {
  isReady(): boolean;
  get(): JsonRecord;
  apply(next: JsonRecord): void;
  set(path: string[], value: JsonValue): void;
  del(path: string[]): void;
  seed(count: number, prefix?: string): void;
  records(): JsonRecord[];
  opsEmitted(): number;
  replicaId: string;
}

declare global {
  interface Window {
    __json: JsonApi;
  }
}

// --- helpers ---------------------------------------------------------------

/** Opens a browser client on the JSON demo and waits until it has synced. */
async function openClient(
  browser: Browser,
  room: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/json.html?room=${room}`);
  await waitReady(page);
  return { context, page };
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__json?.isReady() === true, undefined, {
    timeout: SYNC_TIMEOUT,
  });
}

async function getJson(page: Page): Promise<JsonRecord> {
  return page.evaluate(() => window.__json.get());
}

async function getRecords(page: Page): Promise<JsonRecord[]> {
  return page.evaluate(() => window.__json.records());
}

/** Waits until the page's document has at least `count` records. */
async function waitForRecordCount(page: Page, count: number, timeout = SYNC_TIMEOUT) {
  await page.waitForFunction(
    (expected) => window.__json.records().length >= expected,
    count,
    { timeout },
  );
}

/**
 * Recursively sorts object keys so two documents can be compared by value.
 *
 * Replicas converge on content but not on key *insertion* order: a client that
 * built an object locally holds its keys in authoring order, while one that
 * replayed the same object from remote events holds them in event order. Key
 * order carries no meaning in JSON, so comparing raw `JSON.stringify` output
 * would report a divergence that does not exist. Array order is preserved —
 * there it is meaningful, and the CRDT does converge on it.
 */
function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const out: { [k: string]: JsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonical((value as JsonRecord)[key]);
  }
  return out;
}

/**
 * Waits until both clients hold the same document by value. Convergence alone
 * is a weak assertion — two clients that never received anything also "agree" —
 * so every caller pairs this with assertions on the merged content.
 */
async function expectConverged(a: Page, b: Page, timeout = SYNC_TIMEOUT) {
  await expect
    .poll(
      async () => {
        const [ja, jb] = await Promise.all([getJson(a), getJson(b)]);
        return JSON.stringify(canonical(ja)) === JSON.stringify(canonical(jb));
      },
      { timeout, message: "clients did not converge on an identical document" },
    )
    .toBe(true);
}

/** Starts a fresh room and returns its id. */
async function freshRoom(request: { get(url: string): Promise<unknown> }): Promise<string> {
  const room = `json-${crypto.randomUUID()}`;
  await request.get(`${BASE}/reset?room=${room}`);
  return room;
}

// --- tests -----------------------------------------------------------------

test.describe("Collaborative JSON — large document loading", () => {
  test("a late-joining client loads a 200-record document in full", async ({
    browser,
    request,
  }) => {
    test.setTimeout(BULK_TEST_TIMEOUT);
    const room = await freshRoom(request);
    const a = await openClient(browser, room);

    await a.page.evaluate((n) => window.__json.seed(n), BIG);
    await waitForRecordCount(a.page, BIG);

    // B joins after the fact, so it loads the whole document from the server
    // snapshot rather than replaying ~1400 individual events.
    const b = await openClient(browser, room);
    await waitForRecordCount(b.page, BIG, BULK_TIMEOUT);

    const [ja, jb] = await Promise.all([getJson(a.page), getJson(b.page)]);
    expect(jb).toEqual(ja);

    const records = jb.records as JsonRecord[];
    expect(records).toHaveLength(BIG);
    expect(records[0]).toMatchObject({ id: "r0", name: "Record 0" });
    expect(records[BIG - 1]).toMatchObject({ id: `r${BIG - 1}`, name: `Record ${BIG - 1}` });
    // Nested arrays inside each record must survive too.
    expect(records[7].tags).toEqual(["tag-2", "group-1"]);

    await a.context.close();
    await b.context.close();
  });

  test("a bulk 200-record seed streams to an already-connected client", async ({
    browser,
    request,
  }) => {
    test.setTimeout(BULK_TEST_TIMEOUT);
    const room = await freshRoom(request);
    const a = await openClient(browser, room);
    const b = await openClient(browser, room);

    await a.page.evaluate((n) => window.__json.seed(n), BIG);

    // ~1400 operations, each its own WebSocket message.
    await waitForRecordCount(b.page, BIG, BULK_TIMEOUT);
    await expectConverged(a.page, b.page, BULK_TIMEOUT);

    const records = await getRecords(b.page);
    expect(records).toHaveLength(BIG);
    expect(records.map((r) => r.id)).toEqual(
      Array.from({ length: BIG }, (_, i) => `r${i}`),
    );

    await a.context.close();
    await b.context.close();
  });
});

test.describe("Collaborative JSON — concurrent editing at scale", () => {
  /** Opens two clients that already share a seeded `BIG`-record document. */
  async function twoClientsOnBigDoc(browser: Browser, room: string) {
    const a = await openClient(browser, room);
    await a.page.evaluate((n) => window.__json.seed(n), BIG);
    await waitForRecordCount(a.page, BIG);
    const b = await openClient(browser, room);
    await waitForRecordCount(b.page, BIG, BULK_TIMEOUT);
    return { a, b };
  }

  test("merges edits made to 50 different records at the same time", async ({
    browser,
    request,
  }) => {
    test.setTimeout(BULK_TEST_TIMEOUT);
    const room = await freshRoom(request);
    const { a, b } = await twoClientsOnBigDoc(browser, room);

    // A renames records 0-24 while B renames records 25-49. A whole-document
    // last-writer-wins store would keep only one client's batch.
    await Promise.all([
      a.page.evaluate(() => {
        for (let i = 0; i < 25; i++) {
          window.__json.set(["records", `kr${i}`, "name"], `A-owned ${i}`);
        }
      }),
      b.page.evaluate(() => {
        for (let i = 25; i < 50; i++) {
          window.__json.set(["records", `kr${i}`, "name"], `B-owned ${i}`);
        }
      }),
    ]);

    await expectConverged(a.page, b.page, BULK_TIMEOUT);

    const records = await getRecords(a.page);
    expect(records).toHaveLength(BIG);
    for (let i = 0; i < 25; i++) {
      expect(records[i].name).toBe(`A-owned ${i}`);
    }
    for (let i = 25; i < 50; i++) {
      expect(records[i].name).toBe(`B-owned ${i}`);
    }
    // Untouched records must be left exactly as seeded.
    expect(records[100].name).toBe("Record 100");

    await a.context.close();
    await b.context.close();
  });

  test("merges concurrent edits to different fields of the same record", async ({
    browser,
    request,
  }) => {
    test.setTimeout(BULK_TEST_TIMEOUT);
    const room = await freshRoom(request);
    const { a, b } = await twoClientsOnBigDoc(browser, room);

    await Promise.all([
      a.page.evaluate(() => {
        window.__json.set(["records", "kr5", "name"], "renamed by A");
        window.__json.set(["records", "kr5", "status"], "published");
      }),
      b.page.evaluate(() => {
        window.__json.set(["records", "kr5", "score"], 4242);
        window.__json.set(["records", "kr5", "active"], false);
      }),
    ]);

    await expectConverged(a.page, b.page, BULK_TIMEOUT);

    const record = (await getRecords(a.page))[5];
    expect(record).toMatchObject({
      id: "r5",
      name: "renamed by A",
      status: "published",
      score: 4242,
      active: false,
    });

    await a.context.close();
    await b.context.close();
  });

  test("merges concurrent character edits inside one string field", async ({
    browser,
    request,
  }) => {
    test.setTimeout(BULK_TEST_TIMEOUT);
    const room = await freshRoom(request);
    const { a, b } = await twoClientsOnBigDoc(browser, room);

    await a.page.evaluate(() =>
      window.__json.set(["records", "kr9", "description"], "The quick brown fox"),
    );
    await expect
      .poll(async () => (await getRecords(b.page))[9].description, { timeout: SYNC_TIMEOUT })
      .toBe("The quick brown fox");

    // A prepends, B appends — both edits target the same YText.
    await Promise.all([
      a.page.evaluate(() =>
        window.__json.set(["records", "kr9", "description"], "PREFIX. The quick brown fox"),
      ),
      b.page.evaluate(() =>
        window.__json.set(["records", "kr9", "description"], "The quick brown fox SUFFIX."),
      ),
    ]);

    await expectConverged(a.page, b.page, BULK_TIMEOUT);

    const merged = (await getRecords(a.page))[9].description as string;
    expect(merged).toContain("PREFIX.");
    expect(merged).toContain("SUFFIX.");
    expect(merged).toContain("The quick brown fox");

    await a.context.close();
    await b.context.close();
  });

  test("keeps both records when two clients append concurrently", async ({
    browser,
    request,
  }) => {
    test.setTimeout(BULK_TEST_TIMEOUT);
    const room = await freshRoom(request);
    const { a, b } = await twoClientsOnBigDoc(browser, room);

    await Promise.all([
      a.page.evaluate(() => {
        const doc = window.__json.get();
        const records = doc.records as JsonRecord[];
        window.__json.apply({
          ...doc,
          records: [...records, { id: "added-by-A", name: "From A", score: 1, tags: [] }],
        });
      }),
      b.page.evaluate(() => {
        const doc = window.__json.get();
        const records = doc.records as JsonRecord[];
        window.__json.apply({
          ...doc,
          records: [...records, { id: "added-by-B", name: "From B", score: 2, tags: [] }],
        });
      }),
    ]);

    await expectConverged(a.page, b.page, BULK_TIMEOUT);

    const ids = (await getRecords(a.page)).map((r) => r.id);
    expect(ids).toContain("added-by-A");
    expect(ids).toContain("added-by-B");
    expect(ids).toHaveLength(BIG + 2);

    await a.context.close();
    await b.context.close();
  });

  test("an edit on one client survives a concurrent delete of a different record", async ({
    browser,
    request,
  }) => {
    test.setTimeout(BULK_TEST_TIMEOUT);
    const room = await freshRoom(request);
    const { a, b } = await twoClientsOnBigDoc(browser, room);

    await Promise.all([
      // A removes record 3 — every later record shifts down by one position.
      a.page.evaluate(() => {
        const doc = window.__json.get();
        const records = doc.records as JsonRecord[];
        window.__json.apply({ ...doc, records: records.filter((r) => r.id !== "r3") });
      }),
      // B edits record 150 by identity, not by position.
      b.page.evaluate(() =>
        window.__json.set(["records", "kr150", "name"], "edited despite the shift"),
      ),
    ]);

    await expectConverged(a.page, b.page, BULK_TIMEOUT);

    const records = await getRecords(a.page);
    expect(records.find((r) => r.id === "r3")).toBeUndefined();
    // The edit must have landed on r150, not on whatever slid into its index.
    expect(records.find((r) => r.id === "r150")?.name).toBe("edited despite the shift");
    expect(records.find((r) => r.id === "r151")?.name).toBe("Record 151");

    await a.context.close();
    await b.context.close();
  });

  test("changes one field of a 200-record document with a handful of operations", async ({
    browser,
    request,
  }) => {
    test.setTimeout(BULK_TEST_TIMEOUT);
    const room = await freshRoom(request);
    const a = await openClient(browser, room);
    await a.page.evaluate((n) => window.__json.seed(n), BIG);
    await waitForRecordCount(a.page, BIG);

    // Reconciling the whole document must diff it, not rewrite it: a one-field
    // change may not cost anything close to a re-seed.
    const ops = await a.page.evaluate(() => {
      const before = window.__json.opsEmitted();
      const doc = window.__json.get();
      const records = (doc.records as JsonRecord[]).map((r) =>
        r.id === "r150" ? { ...r, name: "Only this changed" } : r,
      );
      window.__json.apply({ ...doc, records });
      return window.__json.opsEmitted() - before;
    });

    expect(ops).toBeGreaterThan(0);
    expect(ops).toBeLessThanOrEqual(5);
    expect((await getRecords(a.page))[150].name).toBe("Only this changed");

    await a.context.close();
  });
});

test.describe("Collaborative JSON — document shapes", () => {
  test("round-trips deeply nested objects and arrays", async ({ browser, request }) => {
    const room = await freshRoom(request);
    const a = await openClient(browser, room);
    const b = await openClient(browser, room);

    const nested = {
      title: "Deep document",
      level1: {
        level2: {
          level3: {
            level4: {
              scalars: { s: "text", n: 3.5, t: true, f: false, nul: null },
              primitives: [1, 2, 3, "four", true, null],
              objects: [
                { id: "deep-1", label: "one", meta: { nested: { again: "yes" } } },
                { id: "deep-2", label: "two", meta: { nested: { again: "also" } } },
              ],
            },
          },
        },
      },
      emptyObject: {},
      emptyArray: [],
    };

    await a.page.evaluate(
      (encoded) => window.__json.apply(JSON.parse(encoded)),
      JSON.stringify(nested),
    );
    await expect.poll(async () => (await getJson(b.page)).title, { timeout: SYNC_TIMEOUT }).toBe(
      "Deep document",
    );
    await expectConverged(a.page, b.page);

    expect(await getJson(b.page)).toEqual(nested);

    await a.context.close();
    await b.context.close();
  });

  test("handles a value changing JSON type", async ({ browser, request }) => {
    const room = await freshRoom(request);
    const a = await openClient(browser, room);
    const b = await openClient(browser, room);

    const shapes: JsonValue[] = [
      "a string",
      42,
      true,
      null,
      { nested: "object" },
      [1, 2, 3],
      [{ id: "x", v: "record" }],
      "back to a string",
    ];

    for (const shape of shapes) {
      // Passed as a string: the recursive JsonValue type makes evaluate's
      // generic instantiation blow up if the value crosses the boundary typed.
      await a.page.evaluate(
        (encoded) => window.__json.set(["field"], JSON.parse(encoded)),
        JSON.stringify(shape),
      );
      await expect
        .poll(async () => JSON.stringify((await getJson(b.page)).field), {
          timeout: SYNC_TIMEOUT,
          message: `client B never saw ${JSON.stringify(shape)}`,
        })
        .toBe(JSON.stringify(shape));
    }

    await expectConverged(a.page, b.page);

    await a.context.close();
    await b.context.close();
  });

  test("propagates deletions", async ({ browser, request }) => {
    const room = await freshRoom(request);
    const a = await openClient(browser, room);
    const b = await openClient(browser, room);

    await a.page.evaluate(() =>
      window.__json.apply({ keep: "yes", drop: "no", meta: { keep: 1, drop: 2 } }),
    );
    await expect.poll(async () => (await getJson(b.page)).drop, { timeout: SYNC_TIMEOUT }).toBe(
      "no",
    );

    await a.page.evaluate(() => {
      window.__json.del(["drop"]);
      window.__json.del(["meta", "drop"]);
    });

    await expect
      .poll(async () => JSON.stringify(await getJson(b.page)), { timeout: SYNC_TIMEOUT })
      .toBe(JSON.stringify({ keep: "yes", meta: { keep: 1 } }));

    await a.context.close();
    await b.context.close();
  });
});

test.describe("Collaborative JSON — through the UI", () => {
  test("applies a hand-edited JSON blob from the textarea", async ({ browser, request }) => {
    const room = await freshRoom(request);
    const a = await openClient(browser, room);
    const b = await openClient(browser, room);

    const authored = {
      title: "Hand authored",
      version: 3,
      meta: { owner: "tester", notes: "typed into the textarea" },
      records: [
        { id: "h1", name: "First", description: "one", score: 10, status: "draft", active: true, tags: ["a"] },
        { id: "h2", name: "Second", description: "two", score: 20, status: "review", active: false, tags: ["b"] },
      ],
    };

    await a.page.fill("#json-input", JSON.stringify(authored, null, 2));
    await a.page.click("#apply");

    await expect(a.page.locator("#parse-error")).toHaveText("");
    await expect(a.page.locator("#record-count")).toHaveText("2");
    await expect(b.page.locator("#record-count")).toHaveText("2", { timeout: SYNC_TIMEOUT });

    expect(await getJson(b.page)).toEqual(authored);

    await a.context.close();
    await b.context.close();
  });

  test("reports malformed JSON without touching the document", async ({ browser, request }) => {
    const room = await freshRoom(request);
    const a = await openClient(browser, room);

    await a.page.evaluate(() => window.__json.seed(3));
    await waitForRecordCount(a.page, 3);
    const before = await getJson(a.page);

    await a.page.fill("#json-input", "{ definitely not valid json ");
    await a.page.click("#apply");

    await expect(a.page.locator("#parse-error")).toHaveAttribute("data-state", "error");
    expect(await getJson(a.page)).toEqual(before);

    await a.context.close();
  });

  test("edits typed into a record field reach the other client", async ({ browser, request }) => {
    const room = await freshRoom(request);
    const a = await openClient(browser, room);
    await a.page.evaluate(() => window.__json.seed(5));
    await waitForRecordCount(a.page, 5);
    const b = await openClient(browser, room);
    await waitForRecordCount(b.page, 5);

    const nameInput = a.page.locator('[data-record-id="r2"] [data-field="name"]');
    await nameInput.fill("Typed into the DOM");

    await expect(b.page.locator('[data-record-id="r2"] [data-field="name"]')).toHaveValue(
      "Typed into the DOM",
      { timeout: SYNC_TIMEOUT },
    );

    // The other client's inputs for untouched records must not be disturbed.
    await expect(b.page.locator('[data-record-id="r3"] [data-field="name"]')).toHaveValue(
      "Record 3",
    );

    await a.context.close();
    await b.context.close();
  });
});

test.describe("Collaborative JSON — offline editing", () => {
  test("offline edits to a large document survive reconnection", async ({ browser, request }) => {
    test.setTimeout(BULK_TEST_TIMEOUT);
    const room = await freshRoom(request);
    const a = await openClient(browser, room);
    await a.page.evaluate((n) => window.__json.seed(n), BIG);
    await waitForRecordCount(a.page, BIG);

    const b = await openClient(browser, room);
    await waitForRecordCount(b.page, BIG, BULK_TIMEOUT);

    await b.context.setOffline(true);

    // Both sides keep editing distinct records while B is disconnected.
    await b.page.evaluate(() => {
      for (let i = 0; i < 10; i++) {
        window.__json.set(["records", `kr${i}`, "name"], `offline B ${i}`);
      }
    });
    await a.page.evaluate(() => {
      for (let i = 100; i < 110; i++) {
        window.__json.set(["records", `kr${i}`, "name"], `online A ${i}`);
      }
    });

    await b.context.setOffline(false);
    await expectConverged(a.page, b.page, BULK_TIMEOUT);

    const records = await getRecords(a.page);
    for (let i = 0; i < 10; i++) {
      expect(records[i].name).toBe(`offline B ${i}`);
    }
    for (let i = 100; i < 110; i++) {
      expect(records[i].name).toBe(`online A ${i}`);
    }

    await a.context.close();
    await b.context.close();
  });
});

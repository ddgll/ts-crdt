import { test, expect } from "@playwright/test";

test.describe("Collaborative Text Editing (Text-DB Mode)", () => {
  test("should sync text between two clients and persist to SQLite", async ({ browser, request }) => {
    const roomId = `room-${crypto.randomUUID()}`;
    // Reset the room's state
    await request.get(`http://localhost:3000/reset-text?room=${roomId}`);

    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();

    // 1. Connect first two clients
    await page1.goto(`http://localhost:3000/text-db.html?room=${roomId}`);
    await page2.goto(`http://localhost:3000/text-db.html?room=${roomId}`);

    await page1.waitForSelector("#user1");
    await page2.waitForSelector("#user1");

    const textarea1 = page1.locator("#user1");
    const textarea2 = page2.locator("#user1");

    await expect(textarea1).toBeEnabled();
    await expect(textarea2).toBeEnabled();

    // 2. Client 1 types text
    const text1 = "Hello from client 1 in Text-DB mode";
    await textarea1.fill(text1);
    await expect(textarea2).toHaveValue(text1, { timeout: 2000 });

    // 3. Client 2 appends text
    const text2 = text1 + " - appended by client 2";
    await textarea2.fill(text2);
    await expect(textarea1).toHaveValue(text2, { timeout: 2000 });

    // 4. Close first two clients to simulate server unloading the active connections/state
    await context1.close();
    await context2.close();

    // 5. Connect a third client to the same room.
    // It should load the persisted text content from the SQLite database.
    const context3 = await browser.newContext();
    const page3 = await context3.newPage();
    await page3.goto(`http://localhost:3000/text-db.html?room=${roomId}`);

    await page3.waitForSelector("#user1");
    const textarea3 = page3.locator("#user1");
    await expect(textarea3).toBeEnabled();

    // It must load the merged string content persisted in the database!
    await expect(textarea3).toHaveValue(text2, { timeout: 2000 });

    await context3.close();
  });
});

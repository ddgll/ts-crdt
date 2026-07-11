import { test, expect } from "@playwright/test";
import { promisify } from "util";
import crypto from "crypto";

const sleep = promisify(setTimeout);

test.describe("Server Recovery", () => {
  test("should persist and recover data if server restarts", async ({
    browser,
    request,
  }) => {
    const roomId = `room-${crypto.randomUUID()}`;
    // Full reset clears DB too
    await request.get(`http://localhost:3000/reset-text?room=${roomId}`);

    const context1 = await browser.newContext();
    const page1 = await context1.newPage();

    // 1. Client A connects to Text-DB mode
    await page1.goto(`http://localhost:3000/text-db.html?room=${roomId}`);
    await page1.waitForSelector("#user1");
    const textarea1 = page1.locator("#user1");
    await expect(textarea1).toBeEnabled();

    // Make edits
    const initialText = "Pre-crash state. ";
    await textarea1.fill(initialText);
    await expect(textarea1).toHaveValue(initialText);
    
    // Wait a little for DB sync (which is fast, but just in case)
    await sleep(500);

    // 2. Client A goes offline, simulating network disconnect
    await context1.setOffline(true);

    // 3. Client A types more text offline
    const offlineText = initialText + "Client A offline edits. ";
    await textarea1.fill(offlineText);
    await expect(textarea1).toHaveValue(offlineText);

    // 4. Simulate a Server Crash by evicting the server instance from memory,
    // which forces the next connection to re-load from the SQLite database.
    const evictRes = await request.get(`http://localhost:3000/api/evict?room=${roomId}`);
    expect(evictRes.ok()).toBeTruthy();

    // 5. Client A comes back online, connects to the "restarted" server
    await context1.setOffline(false);
    await sleep(1000);

    // 6. Client B connects
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await page2.goto(`http://localhost:3000/text-db.html?room=${roomId}`);
    await page2.waitForSelector("#user1");
    const textarea2 = page2.locator("#user1");
    await expect(textarea2).toBeEnabled();

    // 7. Verify Client B receives both pre-crash state (from DB) and post-crash offline edits (from Client A syncing)
    await expect(textarea2).toHaveValue(offlineText, { timeout: 3000 });

    await context1.close();
    await context2.close();
  });
});

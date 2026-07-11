import { test, expect } from "@playwright/test";
import { promisify } from "util";

const sleep = promisify(setTimeout);

test.describe("Reconnection after compaction", () => {
  test("should handle reconnection after server compaction", async ({
    browser,
    request,
  }) => {
    const roomId = `room-${crypto.randomUUID()}`;
    await request.get(`http://localhost:3000/reset?room=${roomId}`);

    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();

    // 1. Connect two clients
    await page1.goto(`http://localhost:3000?room=${roomId}`);
    await page2.goto(`http://localhost:3000?room=${roomId}`);

    await page1.waitForSelector("#user1");
    await page2.waitForSelector("#user1");

    const textarea1 = page1.locator("#user1");
    const textarea2 = page2.locator("#user1");

    await expect(textarea1).toBeEnabled();
    await expect(textarea2).toBeEnabled();

    // Make initial edits
    const initialText = "Initial state. ";
    await textarea1.fill(initialText);
    await expect(textarea2).toHaveValue(initialText, { timeout: 2000 });

    // 2. Disconnect client 2
    await context2.setOffline(true);

    // 3. Make more edits on client 1 (enough to trigger compaction if it were automatic)
    const newText = initialText + "Client 1 kept editing. ";
    await textarea1.fill(newText);
    await expect(textarea1).toHaveValue(newText);
    await sleep(500); // Give it time to sync to server

    // 4. Trigger compaction via API
    const compactRes = await request.get(`http://localhost:3000/api/compact?room=${roomId}`);
    expect(compactRes.ok()).toBeTruthy();

    // 5. Reconnect client 2
    await context2.setOffline(false);
    
    // Make sure we have reconnected and synchronized
    await sleep(2000);

    // 6. Verify both clients converge
    const finalValue1 = await textarea1.inputValue();
    const finalValue2 = await textarea2.inputValue();

    // Both should be exactly the same
    expect(finalValue1).toBe(finalValue2);
    expect(finalValue2).toBe(newText);

    // Also verify that client 2 can still make edits
    const client2Edit = newText + "Client 2 is back.";
    await textarea2.fill(client2Edit);
    await expect(textarea1).toHaveValue(client2Edit, { timeout: 2000 });

    await context1.close();
    await context2.close();
  });
});

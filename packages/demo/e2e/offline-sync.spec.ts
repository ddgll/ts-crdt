import { test, expect } from "@playwright/test";
import { promisify } from "util";

const sleep = promisify(setTimeout);

test.describe("Simultaneous Offline/Online Editing", () => {
  test("should sync correctly when one user edits offline and another edits online simultaneously", async ({
    browser,
    request,
  }) => {
    const roomId = `room-${crypto.randomUUID()}`;
    await request.get(`http://localhost:3000/reset?room=${roomId}`);

    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();

    await page1.goto(`http://localhost:3000?room=${roomId}`);
    await page2.goto(`http://localhost:3000?room=${roomId}`);

    await page1.waitForSelector("#user1");
    await page2.waitForSelector("#user1");

    const textarea1 = page1.locator("#user1");
    const textarea2 = page2.locator("#user1");

    await expect(textarea1).toBeEnabled();
    await expect(textarea2).toBeEnabled();

    // 1. Initial shared state
    const initialText = "Base text. ";
    await textarea1.fill(initialText);
    await expect(textarea2).toHaveValue(initialText, { timeout: 2000 });

    // 2. User 1 goes offline
    await context1.setOffline(true);

    // 3. Both users edit simultaneously
    // User 1 (offline) appends text
    const offlineText = "Base text. User 1 offline edit. ";
    await textarea1.fill(offlineText);
    await expect(textarea1).toHaveValue(offlineText);

    // User 2 (online) appends text
    const onlineText = "Base text. User 2 online edit. ";
    await textarea2.fill(onlineText);
    await expect(textarea2).toHaveValue(onlineText);

    // 4. User 1 comes back online
    await context1.setOffline(false);

    // Wait for reconnection and synchronization
    await sleep(2000);

    // 5. Verify convergence
    const finalValue1 = await textarea1.inputValue();
    const finalValue2 = await textarea2.inputValue();

    // Both should be exactly the same
    expect(finalValue1).toBe(finalValue2);
    
    // The merged text should contain elements from both edits
    expect(finalValue1).toContain("User 1 offline edit.");
    expect(finalValue1).toContain("User 2 online edit.");

    await context1.close();
    await context2.close();
  });
});

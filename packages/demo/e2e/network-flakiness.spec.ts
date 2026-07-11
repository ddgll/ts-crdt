import { test, expect } from "@playwright/test";
import { promisify } from "util";
import crypto from "crypto";

const sleep = promisify(setTimeout);

test.describe("Network Flakiness", () => {
  test("should handle rapid offline/online toggling and eventual consistency", async ({
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

    const textarea1 = page1.locator("#user1");
    const textarea2 = page2.locator("#user1");

    await expect(textarea1).toBeEnabled();
    await expect(textarea2).toBeEnabled();

    // 1. Initial shared state
    const initialText = "Start. ";
    await textarea1.fill(initialText);
    await expect(textarea2).toHaveValue(initialText, { timeout: 2000 });

    // 2. Simulate flakiness on User 1
    // Toggle offline/online rapidly while editing
    await context1.setOffline(true);
    await textarea1.fill("Start. 1");
    await context1.setOffline(false);
    
    await textarea2.fill("Start. 1 2"); // User 2 concurrently editing
    
    await context1.setOffline(true);
    await textarea1.fill("Start. 1 3");
    
    await context1.setOffline(false);
    
    // Simulate delay
    await sleep(500);

    await context1.setOffline(true);
    await textarea1.fill("Start. 1 3 4");

    // 3. User 1 comes back online permanently
    await context1.setOffline(false);

    // Wait for reconnection and synchronization
    await sleep(2000);

    // 5. Verify convergence
    const finalValue1 = await textarea1.inputValue();
    const finalValue2 = await textarea2.inputValue();

    // Both should be exactly the same
    expect(finalValue1).toBe(finalValue2);
    
    await context1.close();
    await context2.close();
  });
});

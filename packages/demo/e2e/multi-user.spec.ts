import { test, expect } from "@playwright/test";
import { promisify } from "util";

const sleep = promisify(setTimeout);

test.describe("Multi-User Collaborative Text Editing", () => {
  test.beforeEach(async ({ page }) => {
    await page.request.get("http://localhost:3000/reset");
  });
  test("should sync text between three clients", async ({ browser }) => {
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    const context3 = await browser.newContext();
    const page3 = await context3.newPage();

    await page1.goto("http://localhost:3000");
    await page2.goto("http://localhost:3000");
    await page3.goto("http://localhost:3000");

    await page1.waitForSelector("#user1");
    await page2.waitForSelector("#user1");
    await page3.waitForSelector("#user1");

    const textarea1 = page1.locator("#user1");
    const textarea2 = page2.locator("#user1");
    const textarea3 = page3.locator("#user1");

    await expect(textarea1).toBeEnabled();
    await expect(textarea2).toBeEnabled();
    await expect(textarea3).toBeEnabled();

    const text1 = "Hello from user 1";
    await textarea1.fill(text1);
    await expect(textarea2).toHaveValue(text1, { timeout: 2000 });
    await expect(textarea3).toHaveValue(text1, { timeout: 2000 });

    const text2 = text1 + " Hello from user 2";
    await textarea2.fill(text2);
    await expect(textarea1).toHaveValue(text2, { timeout: 2000 });
    await expect(textarea3).toHaveValue(text2, { timeout: 2000 });

    const text3 = text2 + " Hello from user 3";
    await textarea3.fill(text3);
    await expect(textarea1).toHaveValue(text3, { timeout: 2000 });
    await expect(textarea2).toHaveValue(text3, { timeout: 2000 });

    await context1.close();
    await context2.close();
    await context3.close();
  });

  test("should sync text correctly when a client reconnects after being offline", async ({
    browser,
  }) => {
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();

    await page1.goto("http://localhost:3000");
    await page2.goto("http://localhost:3000");

    await page1.waitForSelector("#user1");
    await page2.waitForSelector("#user1");

    const textarea1 = page1.locator("#user1");
    const textarea2 = page2.locator("#user1");

    await expect(textarea1).toBeEnabled();
    await expect(textarea2).toBeEnabled();

    const initialText = "Initial text";
    await textarea1.fill(initialText);
    await expect(textarea2).toHaveValue(initialText, { timeout: 2000 });

    // Simulate client 2 going offline
    await context2.setOffline(true);

    const text1 = "Initial text from user 1";
    await textarea1.fill(text1);
    await expect(textarea1).toHaveValue(text1);

    // User 2 makes changes while offline
    const text2 = "Initial text from user 2";
    await textarea2.fill(text2);
    await expect(textarea2).toHaveValue(text2);

    // Simulate client 2 coming back online
    await context2.setOffline(false);

    // Wait for reconnection and synchronization
    await sleep(2000);

    // Both clients should have the merged text. The exact merge result depends on the CRDT implementation.
    // For this test, we'll assume a specific merge behavior (e.g., user 1's changes appear first).
    // A more robust test might check for the presence of both "from user 1" and "from user 2".
    const finalValue = await textarea1.inputValue();
    expect(finalValue).toContain("from user 1");
    expect(finalValue).toContain("from user 2");

    const finalValue2 = await textarea2.inputValue();
    expect(finalValue2).toContain("from user 1");
    expect(finalValue2).toContain("from user 2");

    await context1.close();
    await context2.close();
  });
});

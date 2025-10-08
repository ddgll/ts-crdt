import { test, expect } from "@playwright/test";

test.describe("Collaborative Text Editing", () => {
  test.beforeEach(async ({ page }) => {
    await page.request.get("http://localhost:3000/reset");
  });
  test("should sync text between two clients", async ({ browser }) => {
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

    const text1 = "Hello from user 1";
    await textarea1.fill(text1);
    await expect(textarea2).toHaveValue(text1, { timeout: 2000 });

    const finalText = text1 + " Hello from user 2";
    await textarea2.fill(finalText);
    await expect(textarea1).toHaveValue(finalText, {
      timeout: 2000,
    });

    await context1.close();
    await context2.close();
  });
});

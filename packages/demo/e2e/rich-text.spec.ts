import { test, expect } from "@playwright/test";
import crypto from "crypto";

test.describe("Rich Text Collaborative Editing", () => {
  test("should sync rich text formatting between two clients", async ({ browser, request }) => {
    const roomId = `room-${crypto.randomUUID()}`;
    await request.get(`http://localhost:3000/reset?room=${roomId}`);

    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();

    await page1.goto(`http://localhost:3000/rich.html?room=${roomId}`);
    await page2.goto(`http://localhost:3000/rich.html?room=${roomId}`);

    await page1.waitForSelector(".ProseMirror");
    await page2.waitForSelector(".ProseMirror");

    const editor1 = page1.locator(".ProseMirror");
    const editor2 = page2.locator(".ProseMirror");

    // Type text in editor 1
    await editor1.click();
    await page1.keyboard.type("Hello world");
    
    // Wait for sync to editor 2
    await expect(editor2).toHaveText("Hello world", { timeout: 2000 });

    // Triple click to select all text
    await editor1.click({ clickCount: 3 });
    
    // Click bold button
    await page1.click("#bold");

    // Check if it's bold in editor 2
    // ProseMirror uses <strong> for bold
    await expect(editor2.locator("strong")).toContainText("Hello world", { timeout: 2000 });

    await context1.close();
    await context2.close();
  });
});

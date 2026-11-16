import { expect, test, type Page } from "@playwright/test";

// Editor polish, measured in a real browser: Blockly injects its own stylesheet, so computed styles
// (not attributes) are what the child sees.

const FLYOUT_BG = "svg.blocklyFlyout:not(.blocklyTrashcanFlyout) .blocklyFlyoutBackground";
const fillOpacity = (page: Page) =>
  page.locator(FLYOUT_BG).first().evaluate((el) => getComputedStyle(el).fillOpacity);

test.describe("flyout opacity", () => {
  test("Icons: solid flyout", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(FLYOUT_BG).first()).toBeAttached();
    expect(await fillOpacity(page)).toBe("1");
  });

  test("Advanced: 60% flyout once a category is open, blocks stay opaque", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Advanced level", exact: true }).click();
    await page.locator(".blocklyToolboxCategory").first().click();
    await expect(page.locator(FLYOUT_BG).first()).toBeVisible();
    expect(await fillOpacity(page)).toBe("0.6");
    const block = page
      .locator("svg.blocklyFlyout:not(.blocklyTrashcanFlyout) .blocklyPath")
      .first();
    expect(await block.evaluate((el) => getComputedStyle(el).fillOpacity)).toBe("1");
  });
});

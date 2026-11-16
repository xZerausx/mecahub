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

test.describe("level tooltips", () => {
  const advanced = () => ({ name: "Advanced level", exact: true }) as const;
  const tip = (page: Page) => page.locator(".level-tip", { hasText: /./ }).nth(1);

  test("mouse: opens on hover, stays while the pointer moves onto it, Esc dismisses it", async ({
    page,
  }) => {
    await page.goto("/");
    const button = page.getByRole("button", advanced());
    await button.hover();
    await expect(tip(page)).toBeVisible();
    await tip(page).hover(); // the pointer crosses the gap and rests on the tip
    await expect(tip(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tip(page)).toBeHidden();
    await page.mouse.move(5, 400); // leave: the next hover starts fresh
    await button.hover();
    await expect(tip(page)).toBeVisible();
  });

  test("the tip never covers STOP", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", advanced()).hover();
    await expect(tip(page)).toBeVisible();
    const stop = page.getByRole("button", { name: "Stop everything" });
    const [s, t] = [await stop.boundingBox(), await tip(page).boundingBox()];
    expect(s && t && s.x < t.x + t.width && t.x < s.x + s.width && s.y < t.y + t.height).toBe(
      false,
    );
  });

  test("keyboard focus shows it and Esc hides it", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab"); // run
    await page.keyboard.press("Tab"); // stop
    await page.keyboard.press("Tab"); // first level button
    await page.keyboard.press("Tab"); // advanced
    await expect(page.getByRole("button", advanced())).toBeFocused();
    await expect(tip(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tip(page)).toBeHidden();
  });

  test.describe("touch", () => {
    test.use({ hasTouch: true, isMobile: true });
    test("a tap leaves no sticky tooltip over the workspace", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", advanced()).tap();
      await expect(page.getByRole("button", advanced())).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".level-tip:visible")).toHaveCount(0);
    });
  });
});

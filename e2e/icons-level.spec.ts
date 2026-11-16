import { expect, test, type Locator, type Page } from "@playwright/test";

// The Icons level, end to end in a real browser: build a program by dragging pictures from the
// flyout, run it on the simulator, see the wheels move and the light change, STOP it.
// Flyout blocks are found by their accessible name (the alt text from i18n): the DOM order of the
// flyout changes as blocks are dragged out of it.
const BLOCK = { forward: /^Forward/, turnLeft: /^Turn left/, led: /^Light/ } as const;

const FLYOUT_SVG = "svg.blocklyFlyout:not(.blocklyTrashcanFlyout)";
const RUN = "Run the program";
const STOP = "Stop everything";

const flyoutBlock = (page: Page, name: RegExp): Locator =>
  page.locator(FLYOUT_SVG).getByRole("option", { name });
const stacks = (page: Page): Locator =>
  page.locator("svg.blocklySvg > g.blocklyWorkspace > g.blocklyBlockCanvas > g.blocklyDraggable");

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no box");
  return b;
}

/** Drags a flyout block so it snaps under the bottom of the (only) stack on the workspace. */
async function dragUnderStack(page: Page, name: RegExp): Promise<void> {
  const from = await box(flyoutBlock(page, name));
  const stack = await box(stacks(page).first());
  const grab = { x: from.x + 8, y: from.y + from.height / 2 };
  const target = { x: stack.x + 8, y: stack.y + stack.height + from.height / 2 + 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move((grab.x + target.x) / 2, (grab.y + target.y) / 2, { steps: 8 });
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up();
}

const preview = (page: Page) => page.locator("[data-led]");
const moving = async (page: Page) =>
  (await preview(page).getAttribute("data-wheel-a")) !== "stopped" ||
  (await preview(page).getAttribute("data-wheel-b")) !== "stopped";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(FLYOUT_SVG)).toBeVisible();
  await expect(stacks(page)).toHaveCount(1); // the start flag is already there
});

test("builds forward, turn and light under the flag, runs and stops it", async ({ page }) => {
  await dragUnderStack(page, BLOCK.forward);
  await dragUnderStack(page, BLOCK.turnLeft);
  await dragUnderStack(page, BLOCK.led);
  await expect(stacks(page)).toHaveCount(1); // all three snapped into the one stack

  // choose red by its swatch (the first swatch is green)
  await page.locator("svg.blocklySvg .blocklyDropdownField").first().click();
  await page
    .locator('.blocklyMenuItem [alt="red"], .blocklyMenuItem img[alt="red"]')
    .first()
    .click();

  // first run: it drives, turns, lights the hub red and ends by itself
  await page.getByRole("button", { name: RUN }).click();
  await expect.poll(() => moving(page), { timeout: 10_000 }).toBe(true);
  await expect(preview(page)).toHaveAttribute("data-led", "red", { timeout: 30_000 });
  await expect.poll(() => moving(page), { timeout: 10_000 }).toBe(false);

  // second run, stopped half way
  await page.getByRole("button", { name: RUN }).click();
  await expect.poll(() => moving(page), { timeout: 10_000 }).toBe(true);
  await page.getByRole("button", { name: STOP }).click();
  await expect.poll(() => moving(page), { timeout: 2_000 }).toBe(false);
});

test("Escape stops a running program too", async ({ page }) => {
  await dragUnderStack(page, BLOCK.forward);
  await page.getByRole("button", { name: RUN }).click();
  await expect.poll(() => moving(page), { timeout: 10_000 }).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(() => moving(page), { timeout: 2_000 }).toBe(false);
});

test("the Icons level shows no words: only pictures and one-digit numbers", async ({ page }) => {
  await dragUnderStack(page, BLOCK.forward);
  const texts = await page.locator(".editor-workspace .blocklyText").allTextContents();
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) expect(text.trim()).toMatch(/^([1-9]|▾)?$/);
  // the flyout too
  const inFlyout = await page.locator(`${FLYOUT_SVG} .blocklyText`).allTextContents();
  for (const text of inFlyout) expect(text.trim()).toMatch(/^([1-9]|▾)?$/);
});

test("makes no network request outside the app itself", async ({ page, baseURL }) => {
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(baseURL ?? "") && !url.startsWith("data:") && !url.startsWith("blob:")) {
      foreign.push(url);
    }
  });
  await page.goto("/");
  await dragUnderStack(page, BLOCK.forward);
  await page.getByRole("button", { name: RUN }).click();
  await page.getByRole("button", { name: STOP }).click();
  expect(foreign).toEqual([]);
});

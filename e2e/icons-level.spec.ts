import { expect, test, type Locator, type Page } from "@playwright/test";

// The Icons level, end to end in a real browser: build a program by dragging pictures from the
// flyout, run it on the simulator, see the wheels move and the light change, STOP it. Same flow in
// both languages. Flyout blocks are found by their accessible name (the alt text from i18n): the DOM
// order of the flyout changes as blocks are dragged out of it.

const LOCALES = [
  {
    locale: "en-US",
    run: "Run the program",
    stop: "Stop everything",
    forward: /^Forward/,
    turnLeft: /^Turn left/,
    led: /^Light/,
    red: "red",
  },
  {
    locale: "es-ES",
    run: "Correr el programa",
    stop: "Detener todo",
    forward: /^Adelante/,
    turnLeft: /^Girar a la izquierda/,
    led: /^Luz/,
    red: "rojo",
  },
] as const;

const FLYOUT_SVG = "svg.blocklyFlyout:not(.blocklyTrashcanFlyout)";
const MAIN_SVG = "svg.blocklySvg";

const stacks = (page: Page): Locator =>
  page.locator(`${MAIN_SVG} > g.blocklyWorkspace > g.blocklyBlockCanvas > g.blocklyDraggable`);
const preview = (page: Page) =>
  page.getByRole("group", { name: /./ }).and(page.locator("[data-led]"));

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no box");
  return b;
}

/** The flyout scrolls when it is taller than the window (1280x800): bring the block into view. */
async function flyoutBlock(page: Page, name: RegExp): Promise<Locator> {
  const block = page.locator(FLYOUT_SVG).getByRole("option", { name });
  const height = page.viewportSize()?.height ?? 800;
  for (let attempt = 0; attempt < 12; attempt++) {
    const b = await box(block);
    if (b.y >= 0 && b.y + b.height <= height) return block;
    const flyout = await box(page.locator(FLYOUT_SVG));
    await page.mouse.move(flyout.x + flyout.width / 2, flyout.y + flyout.height / 2);
    await page.mouse.wheel(0, b.y < 0 ? -200 : 200);
  }
  throw new Error(`could not scroll ${String(name)} into view`);
}

/** Drags a flyout block so it snaps under the bottom of the (only) stack on the workspace. */
async function dragUnderStack(page: Page, name: RegExp): Promise<void> {
  const from = await box(await flyoutBlock(page, name));
  const stack = await box(stacks(page).first());
  const grab = { x: from.x + 8, y: from.y + from.height / 2 };
  const target = { x: stack.x + 8, y: stack.y + stack.height + from.height / 2 + 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move((grab.x + target.x) / 2, (grab.y + target.y) / 2, { steps: 8 });
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up();
}

const moving = async (page: Page) =>
  (await preview(page).getAttribute("data-wheel-a")) !== "stopped" ||
  (await preview(page).getAttribute("data-wheel-b")) !== "stopped";

for (const l of LOCALES) {
  test.describe(`Icons level (${l.locale})`, () => {
    test.use({ locale: l.locale });

    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await expect(page.locator(FLYOUT_SVG)).toBeVisible();
      await expect(stacks(page)).toHaveCount(1); // the start flag is already there
    });

    test("builds forward, turn and light under the flag, runs and stops it", async ({ page }) => {
      await dragUnderStack(page, l.forward);
      await dragUnderStack(page, l.turnLeft);
      await dragUnderStack(page, l.led);
      await expect(stacks(page)).toHaveCount(1); // all three snapped into the one stack

      // choose red by its swatch (the first swatch is green): the program has one dropdown
      const dropdown = page.locator(`${MAIN_SVG} .blocklyDropdownField`);
      await expect(dropdown).toHaveCount(1);
      await dropdown.click();
      await page
        .locator(".blocklyDropdownMenu")
        .getByRole("option", { name: l.red, exact: true })
        .click();

      // first run: it drives, turns, lights the hub red and ends by itself
      await page.getByRole("button", { name: l.run }).click();
      await expect.poll(() => moving(page), { timeout: 10_000 }).toBe(true);
      await expect(preview(page)).toHaveAttribute("data-led", "red", { timeout: 30_000 });
      await expect.poll(() => moving(page), { timeout: 10_000 }).toBe(false);

      // second run, stopped half way
      await page.getByRole("button", { name: l.run }).click();
      await expect.poll(() => moving(page), { timeout: 10_000 }).toBe(true);
      await page.getByRole("button", { name: l.stop }).click();
      await expect.poll(() => moving(page), { timeout: 2_000 }).toBe(false);
    });

    test("Escape stops a running program too", async ({ page }) => {
      await dragUnderStack(page, l.forward);
      await page.getByRole("button", { name: l.run }).click();
      await expect.poll(() => moving(page), { timeout: 10_000 }).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => moving(page), { timeout: 2_000 }).toBe(false);
    });

    test("shows no words: only pictures and one-digit numbers", async ({ page }) => {
      await dragUnderStack(page, l.forward);
      // an image dropdown has an empty text node: only non-empty text counts
      const visible = ".blocklyText";
      const texts = [
        ...(await page.locator(`.editor-workspace ${visible}`).allTextContents()),
        ...(await page.locator(`${FLYOUT_SVG} ${visible}`).allTextContents()),
      ];
      const words = texts.map((t) => t.trim()).filter((t) => t !== "");
      expect(words.length).toBeGreaterThan(0);
      for (const word of words) expect(word).toMatch(/^[1-9]$/);
    });

    test("makes no network request outside the app itself", async ({ page, baseURL }) => {
      const foreign: string[] = [];
      page.on("request", (request) => {
        const url = request.url();
        if (
          !url.startsWith(baseURL ?? "") &&
          !url.startsWith("data:") &&
          !url.startsWith("blob:")
        ) {
          foreign.push(url);
        }
      });
      await page.goto("/");
      await dragUnderStack(page, l.forward);
      await page.getByRole("button", { name: l.run }).click();
      await page.getByRole("button", { name: l.stop }).click();
      expect(foreign).toEqual([]);
    });
  });
}

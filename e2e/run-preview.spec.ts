import { expect, test, type Locator, type Page } from "@playwright/test";

// What a child sees after pressing Run in the Icons level: the robot preview must show activity.
const FLYOUT_SVG = "svg.blocklyFlyout:not(.blocklyTrashcanFlyout)";
const MAIN_SVG = "svg.blocklySvg";
const stacks = (page: Page): Locator =>
  page.locator(`${MAIN_SVG} > g.blocklyWorkspace > g.blocklyBlockCanvas > g.blocklyDraggable`);

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no box");
  return b;
}

async function dragUnderStack(page: Page, name: RegExp): Promise<void> {
  const block = page.locator(FLYOUT_SVG).getByRole("option", { name });
  const height = page.viewportSize()?.height ?? 800;
  for (let attempt = 0; attempt < 12; attempt++) {
    const b = await box(block);
    if (b.y >= 0 && b.y + b.height <= height) break;
    const flyout = await box(page.locator(FLYOUT_SVG));
    await page.mouse.move(flyout.x + flyout.width / 2, flyout.y + flyout.height / 2);
    await page.mouse.wheel(0, b.y < 0 ? -200 : 200);
  }
  const from = await box(block);
  const stack = await box(stacks(page).first());
  const grab = { x: from.x + 8, y: from.y + from.height / 2 };
  const target = { x: stack.x + 8, y: stack.y + stack.height + from.height / 2 + 2 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move((grab.x + target.x) / 2, (grab.y + target.y) / 2, { steps: 8 });
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up();
}

test("Run shows the robot doing something in the preview", async ({ page }) => {
  await page.goto("/");
  await expect(stacks(page)).toHaveCount(1);
  await dragUnderStack(page, /^Forward/);
  await dragUnderStack(page, /^Light/);
  // record every state the preview goes through: the wheels only move for a moment
  await page.evaluate(() => {
    const el = document.querySelector(".sim-preview");
    const w = window as unknown as { __seen: string[] };
    w.__seen = [];
    const note = () =>
      w.__seen.push(
        ["data-led", "data-wheel-a", "data-wheel-b"].map((a) => el?.getAttribute(a)).join(" "),
      );
    new MutationObserver(note).observe(el as Element, { attributes: true });
  });
  await page.getByRole("button", { name: "Run the program" }).click();
  await expect(page.locator(".sim-preview")).toHaveAttribute("data-led", "green", {
    timeout: 10_000,
  });
  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  expect(seen.some((s) => s.endsWith("forward forward"))).toBe(true);
});

// Any Advanced block needs a level switch, and the switch sends a STOP while Blockly re-injects:
// the busy main thread made that STOP miss its deadline, the transport dropped the link and the
// next Run failed with "not-connected" and showed nothing.
test("Run still shows activity after switching to Advanced and adding an Advanced block", async ({
  page,
}) => {
  await page.goto("/");
  await expect(stacks(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Advanced level", exact: true }).click();
  await page.locator(".blocklyToolboxCategory").nth(1).click(); // Motors
  const flyoutBlock = page.locator(`${FLYOUT_SVG} .blocklyDraggable`).first();
  await expect(flyoutBlock).toBeVisible();
  const from = await box(flyoutBlock);
  const flag = await box(stacks(page).first());
  const grab = { x: from.x + 10, y: from.y + 10 };
  const target = { x: flag.x + 12, y: flag.y + flag.height + 20 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await page.mouse.up();
  await expect(stacks(page)).toHaveCount(1); // snapped under the flag
  await expect(page.locator(`${MAIN_SVG} .blocklyEditableField`).first()).toBeVisible();

  await page.evaluate(() => {
    const el = document.querySelector(".sim-preview") as Element;
    const w = window as unknown as { __seen: string[] };
    w.__seen = [];
    new MutationObserver(() =>
      w.__seen.push(["data-wheel-a", "data-wheel-b"].map((a) => el.getAttribute(a)).join(" ")),
    ).observe(el, { attributes: true });
  });
  await page.getByRole("button", { name: "Run the program" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __seen: string[] }).__seen), {
      timeout: 10_000,
    })
    .toContain("forward stopped");
});

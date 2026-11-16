import { expect, test, type Locator, type Page } from "@playwright/test";

// The editor with a real hub as the device. Chromium has no hub to talk to, so:
//  - without Web Bluetooth the button must explain itself;
//  - with a chooser that is dismissed the editor must stay on the simulator;
//  - the whole flow runs against a simulator-backed hub transport that exists ONLY on the dev server
//    (VITE_E2E_FAKE_HUB=1, set by playwright.config.ts, plus `?fakeHub=1`): a production build does
//    not contain it, which the last test proves by reading the shipped bundle.

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

const preview = (page: Page) => page.locator(".sim-preview");
const connectButton = (page: Page) => page.getByRole("button", { name: "Connect the robot" });

test.describe("without Web Bluetooth", () => {
  test("the button is disabled and says why", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "bluetooth", { value: undefined });
    });
    await page.goto("/");
    const button = connectButton(page);
    await expect(button).toBeDisabled();
    const note = page.locator(`#${await button.getAttribute("aria-describedby")}`);
    await expect(note).toHaveText(
      "This browser can't use Bluetooth. Open the app in Chrome or Edge.",
    );
    await expect(preview(page)).toHaveAttribute("data-source", "simulator");
  });
});

test.describe("a chooser that finds nothing", () => {
  test("dismissing it leaves the editor on the simulator, from inside the click", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __chooser: { calls: number; withGesture: boolean[] } };
      w.__chooser = { calls: 0, withGesture: [] };
      Object.defineProperty(Navigator.prototype, "bluetooth", {
        value: {
          requestDevice: () => {
            w.__chooser.calls++;
            w.__chooser.withGesture.push(navigator.userActivation.isActive);
            return Promise.reject(new DOMException("User cancelled the chooser", "NotFoundError"));
          },
        },
      });
    });
    await page.goto("/");
    await expect(preview(page)).toHaveAttribute("data-source", "simulator");
    // the simulator connects by itself and Chromium does not open the chooser at load
    expect(
      await page.evaluate(
        () => (window as never as { __chooser: { calls: number } }).__chooser.calls,
      ),
    ).toBe(0);
    await connectButton(page).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as never as { __chooser: { calls: number } }).__chooser.calls),
      )
      .toBe(1);
    const gestures = await page.evaluate(
      () => (window as never as { __chooser: { withGesture: boolean[] } }).__chooser.withGesture,
    );
    expect(gestures).toEqual([true]); // the chooser was asked for while the click was still "active"
    await expect(preview(page)).toHaveAttribute("data-source", "simulator");
    await expect(connectButton(page)).toBeEnabled();
    await expect(page.locator(".problem-badge")).toHaveCount(0);
  });
});

test.describe("with a hub (simulator-backed, dev server only)", () => {
  test.skip(Boolean(process.env.E2E_PROD), "the fake hub is not part of a production build");

  test("connect, run, mirror the wheels, STOP, then a dropped link shows the badge", async ({
    page,
  }) => {
    await page.goto("/?fakeHub=1");
    await expect(stacks(page)).toHaveCount(1);
    await dragUnderStack(page, /^Forward/);
    await dragUnderStack(page, /^Light/);
    await expect(preview(page)).toHaveAttribute("data-source", "simulator");

    await connectButton(page).click();
    await expect(preview(page)).toHaveAttribute("data-source", "hub");
    await expect(preview(page).locator(".sim-source")).toHaveText("Hub");
    await expect(page.getByRole("button", { name: "Back to the simulator" })).toBeVisible({
      timeout: 15_000,
    });

    await page.evaluate(() => {
      const el = document.querySelector(".sim-preview") as Element;
      const w = window as unknown as { __seen: string[] };
      w.__seen = [];
      new MutationObserver(() =>
        w.__seen.push(
          ["data-led", "data-wheel-a", "data-wheel-b"].map((a) => el.getAttribute(a)).join(" "),
        ),
      ).observe(el, { attributes: true });
    });
    await page.getByRole("button", { name: "Run the program" }).click();
    await expect(preview(page)).toHaveAttribute("data-led", "green", { timeout: 15_000 });
    const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
    expect(seen.some((s) => s.endsWith("forward forward"))).toBe(true);

    // STOP: the wheels are drawn stopped at once
    await page.getByRole("button", { name: "Run the program" }).click();
    await expect(preview(page)).toHaveAttribute("data-wheel-a", "forward", { timeout: 15_000 });
    await page.getByRole("button", { name: "Stop everything" }).click();
    await expect(preview(page)).toHaveAttribute("data-wheel-a", "stopped");
    await expect(preview(page)).toHaveAttribute("data-wheel-b", "stopped");

    // the link drops by itself: dimmed robot, unknown wheels, a pictogram with a hidden label
    await page.evaluate(() =>
      (window as never as { __fakeHub: { drop(): void } }).__fakeHub.drop(),
    );
    const badge = page.locator(".sim-preview .problem-badge");
    await expect(badge).toHaveAttribute("data-problem", "link-lost");
    await expect(page.locator(".problem-region")).toContainText(
      "The connection to the robot was lost.",
    );
    await expect(preview(page)).toHaveAttribute("data-stale", "");
    await expect(preview(page)).toHaveAttribute("data-wheel-a", "unknown");

    // tapping the badge dismisses it; Back to the simulator returns to a live preview
    await badge.click();
    await expect(badge).toHaveCount(0);
    await page.getByRole("button", { name: "Back to the simulator" }).click();
    await expect(preview(page)).toHaveAttribute("data-source", "simulator");
    await expect(preview(page)).not.toHaveAttribute("data-stale", "");
  });
});

test("the fake hub is not in what is served to children (production build only)", async ({
  page,
  request,
}) => {
  test.skip(!process.env.E2E_PROD, "only a production build can show what ships");
  await page.goto("/");
  const scripts = await page
    .locator("script[src]")
    .evaluateAll((els) => els.map((el) => (el as HTMLScriptElement).src));
  expect(scripts.length).toBeGreaterThan(0);
  const urls = new Set(scripts);
  // include the chunks the entry script imports
  const bundles: string[] = [];
  const queue = [...urls];
  while (queue.length > 0) {
    const url = queue.pop() as string;
    const body = await (await request.get(url)).text();
    bundles.push(body);
    for (const m of body.matchAll(/from"\.\/([\w.-]+\.js)"|import\("\.\/([\w.-]+\.js)"\)/g)) {
      const next = new URL(m[1] ?? m[2] ?? "", url).href;
      if (!urls.has(next)) {
        urls.add(next);
        queue.push(next);
      }
    }
  }
  const all = bundles.join("\n");
  expect(all).not.toContain("__fakeHub");
  expect(all).not.toContain("fakeHub");
  expect(all).not.toContain("VITE_E2E_FAKE_HUB");
  expect([...urls].some((u) => /fake/i.test(u))).toBe(false);
});

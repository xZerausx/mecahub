import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// STOP must never be covered: Blockly's widget, dropdown and tooltip layers use very high z-index
// values (up to 100000 in 13.4.0), so a dropdown could sit over the button.
const zIndexes = (css: string): number[] =>
  [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));

describe("STOP layer", () => {
  const blockly = readFileSync(
    join(dirname(createRequire(import.meta.url).resolve("blockly")), "blockly_compressed.js"),
    "utf8",
  );
  const ours = readFileSync(new URL("./editor.css", import.meta.url), "utf8");
  const blocklyMax = Math.max(...zIndexes(blockly));

  it("sits above every Blockly overlay, always (not only while the modal is open)", () => {
    expect(blocklyMax).toBeGreaterThanOrEqual(100000); // sanity: the scan found Blockly's layers
    const rule = ours.match(/\.big-button\.stop\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/position:\s*relative/);
    const z = zIndexes(rule)[0] ?? 0;
    expect(z).toBeGreaterThan(blocklyMax);
  });

  it("leaves no overlay of ours at or above STOP", () => {
    const stop = zIndexes(ours.match(/\.big-button\.stop\s*\{[^}]*\}/)?.[0] ?? "")[0] ?? 0;
    const others = zIndexes(ours.replace(/\.big-button\.stop\s*\{[^}]*\}/, ""));
    for (const z of others) expect(z).toBeLessThan(stop);
  });

  it("shows level tooltips on hover and keyboard focus only, below STOP and unclipped", () => {
    const tip = ours.match(/\.level-tip\s*\{[^}]*\}/)?.[0] ?? "";
    expect(tip).toMatch(/position:\s*absolute/);
    expect(tip).toMatch(/visibility:\s*hidden/);
    expect(tip).toMatch(/max-width/);
    const stop = zIndexes(ours.match(/\.big-button\.stop\s*\{[^}]*\}/)?.[0] ?? "")[0] ?? 0;
    const z = zIndexes(tip)[0] ?? 0;
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(stop);
    expect(ours).toMatch(/\.level-button:focus-visible\s*\+\s*\.level-tip/);
    // overflow: hidden on the toggle would clip the tooltip
    expect(ours.match(/\.level-toggle\s*\{[^}]*\}/)?.[0] ?? "").not.toMatch(/overflow:\s*hidden/);
  });

  it("tooltips: hover only where hover exists, hoverable, and dismissable", () => {
    // hover rules live inside @media (hover: hover): touch devices have a sticky :hover
    const outside = ours
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@media \(hover: hover\)\s*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, "");
    expect(outside).not.toMatch(/:hover[^{]*\.level-tip/);
    expect(ours).toMatch(/@media \(hover: hover\)[\s\S]*\.level-item:hover \.level-tip/);
    expect(ours).toMatch(/\.level-button:focus-visible \+ \.level-tip/);
    expect(ours).toMatch(/\[data-tips-dismissed\][^{]*\.level-tip[^{]*\{[^}]*visibility:\s*hidden/);
  });

  it("keeps the problem badge and the hub button below STOP and below Blockly's overlays", () => {
    const stop = zIndexes(ours.match(/\.big-button\.stop\s*\{[^}]*\}/)?.[0] ?? "")[0] ?? 0;
    const badge = ours.match(/\.problem-badge\s*\{[^}]*\}/)?.[0] ?? "";
    expect(badge).toMatch(/position:\s*absolute/);
    const z = zIndexes(badge)[0] ?? 0;
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(1000); // same ceiling as the level tooltips
    expect(z).toBeLessThan(stop);
    // nothing of the hub button or the badge may be an overlay of its own
    for (const selector of [".hub-button", ".hub-note"]) {
      const rule = ours.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`))?.[0] ?? "";
      expect(
        zIndexes(rule).every((value) => value < stop),
        selector,
      ).toBe(true);
    }
  });
});

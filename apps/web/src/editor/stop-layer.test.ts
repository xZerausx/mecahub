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
});

import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";
import en from "../../../content/i18n/en.json";
import { BLOCK_STYLES, blockDefinitions } from "./definitions.js";
import { BLOCK_SPECS } from "./spec.js";

// The one place that runs real Blockly (13.4.0) in Node, to check what Blockly actually reads from
// our data: the hat cap comes from a named block style, which the other tests only see as data.
// Blockly's node entry brings jsdom for XML only; a rendered workspace needs the DOM globals too.

type Blockly = typeof import("blockly/core");
type WithHat = { hat?: string };

const GLOBALS = [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "DOMParser",
  "XMLSerializer",
  "getComputedStyle",
  "MutationObserver",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

let Blockly: Blockly;
let dom: JSDOM;
let workspace: InstanceType<Blockly["WorkspaceSvg"]>;

beforeAll(async () => {
  dom = new JSDOM("<!DOCTYPE html><body></body>", { pretendToBeVisual: true });
  for (const key of GLOBALS) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    if (value !== undefined)
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Blockly = await import("blockly/core");
  Blockly.setLocale((await import("blockly/msg/en")) as unknown as Record<string, string>);
  const theme = Blockly.Theme.defineTheme("mh-smoke", {
    name: "mh-smoke",
    base: Blockly.Themes.Classic,
    blockStyles: BLOCK_STYLES,
  });
  Blockly.common.defineBlocksWithJsonArray(blockDefinitions(en));
  const div = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(div);
  workspace = Blockly.inject(div, { theme }) as typeof workspace;
});

describe("real Blockly 13.4.0 reads our block definitions", () => {
  it("registers and instantiates every definition without throwing", () => {
    for (const { type } of BLOCK_SPECS) {
      expect(() => workspace.newBlock(type).initSvg(), type).not.toThrow();
    }
  });

  it("draws every hat with a cap, on every instance", () => {
    const hats = BLOCK_SPECS.filter((b) => b.shape === "hat").map((b) => b.type);
    expect(hats).toHaveLength(5);
    for (const type of hats) {
      for (let i = 0; i < 3; i++) {
        const block = workspace.newBlock(type);
        block.initSvg();
        expect((block as unknown as WithHat).hat, `${type} #${i}`).toBe("cap");
      }
    }
  });

  it("does not give a cap to statements or expressions", () => {
    for (const { type } of BLOCK_SPECS.filter((b) => b.shape !== "hat")) {
      const block = workspace.newBlock(type);
      block.initSvg();
      expect((block as unknown as WithHat).hat, type).not.toBe("cap");
    }
  });
});

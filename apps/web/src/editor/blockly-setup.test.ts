// @vitest-environment jsdom
import { BLOCK_SPECS, BLOCK_STYLES } from "@mecahub/blocks";
import * as Blockly from "blockly/core";
import { describe, expect, it } from "vitest";
import css from "./editor.css?raw";
import { THEME_NAME, ensureBlockly, mecahubTheme, workspaceOptions } from "./blockly-setup.js";

describe("ensureBlockly", () => {
  it("registers every block definition, icon blocks included", () => {
    ensureBlockly("en");
    for (const { type } of BLOCK_SPECS) expect(Blockly.Blocks[type], type).toBeDefined();
  });

  it("is idempotent: a second call for the same locale defines nothing again", () => {
    ensureBlockly("en");
    const warn: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warn.push(args);
    try {
      ensureBlockly("en");
    } finally {
      console.warn = original;
    }
    expect(warn).toEqual([]);
  });

  it("uses the labels of the chosen locale", () => {
    ensureBlockly("es");
    const ws = new Blockly.Workspace();
    const block = ws.newBlock("mh_wait");
    expect(block.toString()).toMatch(/segundos/);
    ws.dispose();
  });
});

describe("mecahubTheme", () => {
  it("is the classic theme plus the block styles that draw the hat caps", () => {
    const theme = mecahubTheme();
    expect(theme.name).toBe(THEME_NAME);
    expect(theme.blockStyles).toMatchObject(BLOCK_STYLES);
    expect(theme.blockStyles.mh_hat).toMatchObject({ hat: "cap" });
    expect(theme.blockStyles).toHaveProperty("logic_blocks"); // the base theme is kept
  });
});

describe("flyout opacity", () => {
  it("advanced: the flyout background is 60% opaque (the blocks stay opaque)", () => {
    const theme = workspaceOptions("advanced", "en").theme as Blockly.Theme;
    expect(theme.componentStyles.flyoutOpacity).toBe(0.6);
    expect(theme.componentStyles.flyoutBackgroundColour).toBeUndefined(); // only the opacity changes
  });

  it("icons: not translucent (the flyout theme is a separate one)", () => {
    const icons = workspaceOptions("icons", "en").theme as Blockly.Theme;
    const advanced = workspaceOptions("advanced", "en").theme as Blockly.Theme;
    expect(icons.componentStyles.flyoutOpacity).not.toBe(0.6);
    expect(icons).not.toBe(advanced);
    expect(icons.name).not.toBe(advanced.name);
  });

  it("both themes keep the hat cap style and the base block styles", () => {
    for (const level of ["icons", "advanced"] as const) {
      const theme = workspaceOptions(level, "en").theme as Blockly.Theme;
      expect(theme.blockStyles.mh_hat, level).toMatchObject({ hat: "cap" });
      expect(theme.blockStyles, level).toHaveProperty("logic_blocks");
    }
  });

  it("the stylesheet does not force the flyout opaque in Advanced", () => {
    const rules = [...css.matchAll(/([^{}]*blocklyFlyoutBackground[^{}]*)\{([^}]*)\}/g)];
    for (const [, selector, body] of rules) {
      if (/fill-opacity/.test(body ?? "")) expect(selector).toMatch(/data-level="icons"/);
    }
  });
});

describe("workspaceOptions", () => {
  it("icons: zelos renderer, scaled up, a flat flyout toolbox and no sounds", () => {
    const options = workspaceOptions("icons", "en");
    expect(options.renderer).toBe("zelos");
    expect(options.zoom?.startScale).toBe(1.5);
    expect(options.toolbox).toMatchObject({ kind: "flyoutToolbox" });
    expect(options.sounds).toBe(false);
    expect(options.theme).toBeDefined();
  });

  it("advanced: categories, default scale", () => {
    const options = workspaceOptions("advanced", "en");
    expect(options.toolbox).toMatchObject({ kind: "categoryToolbox" });
    expect(options.zoom?.startScale ?? 1).toBe(1);
    expect(options.sounds).toBe(false);
  });

  it("serves Blockly's images and cursors from the app itself, never from blockly.com", () => {
    expect(workspaceOptions("icons", "en").media).toBe(`${import.meta.env.BASE_URL}blockly-media/`);
  });

  it("never reaches for the network: no media path to a remote host", () => {
    for (const level of ["icons", "advanced"] as const) {
      expect(JSON.stringify(workspaceOptions(level, "en"))).not.toMatch(/https?:/);
    }
  });
});

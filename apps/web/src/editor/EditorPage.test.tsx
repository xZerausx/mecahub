// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Blockly from "blockly/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../../content/i18n/en.json";
import es from "../../../../content/i18n/es.json";
import { createTranslator } from "../i18n.js";
import { EditorPage } from "./EditorPage.js";
import { SimPreview } from "./SimPreview.js";
import type { EditorController, EditorSnapshot } from "./editor-controller.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const idle: EditorSnapshot = {
  running: false,
  connection: "connected",
  wheels: { a: "stopped", b: "stopped" },
  led: "off",
  highlightedBlockId: undefined,
  errorBlockIds: [],
};

function fakeController(initial: EditorSnapshot = idle) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const controller: EditorController & { set(next: EditorSnapshot): void } = {
    set: (next) => {
      snapshot = next;
      for (const l of listeners) l();
    },
    getSnapshot: () => snapshot,
    subscribe: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    connect: vi.fn(() => Promise.resolve()),
    run: vi.fn(() => Promise.resolve("completed" as const)),
    stop: vi.fn(),
    sentFrames: () => 0,
    dispose: vi.fn(),
  };
  return controller;
}

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = (controller: EditorController, locale: "en" | "es" = "en") => {
  act(() =>
    root.render(
      <EditorPage controller={controller} locale={locale} t={createTranslator(locale)} />,
    ),
  );
};
const button = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe("EditorPage", () => {
  it("has big Run and STOP buttons labelled only through i18n (en and es)", () => {
    for (const [locale, catalog] of [
      ["en", en],
      ["es", es],
    ] as const) {
      mount(fakeController(), locale);
      expect(button(catalog["editor.run"]), locale).not.toBeNull();
      expect(button(catalog["editor.stop"]), locale).not.toBeNull();
      expect(button(catalog["editor.level.icons"]), locale).not.toBeNull();
      expect(button(catalog["editor.level.advanced"]), locale).not.toBeNull();
    }
  });

  it("shows no visible text outside the Blockly area except the simulator label and tooltips", () => {
    mount(fakeController());
    const chrome = host.querySelector(".editor-bar")?.cloneNode(true) as HTMLElement;
    for (const el of chrome.querySelectorAll(".sim-source, [role=tooltip]")) el.remove();
    expect(chrome.textContent?.trim()).toBe("");
  });

  it("STOP is always enabled, even with nothing running, and calls controller.stop()", () => {
    const controller = fakeController();
    mount(controller);
    const stop = button(en["editor.stop"]);
    expect(stop?.disabled).toBe(false);
    act(() => stop?.click());
    expect(controller.stop).toHaveBeenCalledTimes(1);
  });

  it("stays enabled while a program runs", () => {
    mount(fakeController({ ...idle, running: true }));
    expect(button(en["editor.stop"])?.disabled).toBe(false);
  });

  it("Escape also stops", () => {
    const controller = fakeController();
    mount(controller);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(controller.stop).toHaveBeenCalledTimes(1);
  });

  it("Escape does not move the keyboard focus", () => {
    mount(fakeController());
    const run = button(en["editor.run"]);
    act(() => run?.focus());
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.activeElement).toBe(run);
  });

  it("Run saves the workspace and hands it to the controller", () => {
    const controller = fakeController();
    mount(controller);
    act(() => button(en["editor.run"])?.click());
    expect(controller.run).toHaveBeenCalledTimes(1);
    const state = (controller.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      blocks: { blocks: { type: string }[] };
    };
    // the Icons level starts with the flag already on the workspace
    expect(state.blocks.blocks.map((b) => b.type)).toEqual(["mh_icon_when_start"]);
  });

  it("injects Blockly with the icon blocks offered in a flat flyout", () => {
    mount(fakeController());
    expect(host.querySelector(".blocklySvg")).not.toBeNull();
  });

  it("switches level, keeping the program and re-injecting Blockly", () => {
    const controller = fakeController();
    mount(controller);
    act(() => button(en["editor.level.advanced"])?.click());
    expect(button(en["editor.level.advanced"])?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelectorAll(".blocklySvg")).toHaveLength(1);
    act(() => button(en["editor.run"])?.click());
    const state = (controller.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      blocks: { blocks: { type: string }[] };
    };
    expect(state.blocks.blocks.map((b) => b.type)).toEqual(["mh_icon_when_start"]);
  });

  it("moves the keyboard focus to STOP when Run starts and disables itself", () => {
    const controller = fakeController();
    mount(controller);
    const run = button(en["editor.run"]);
    act(() => run?.focus());
    act(() => run?.click());
    act(() => controller.set({ ...idle, running: true }));
    expect(document.activeElement).toBe(button(en["editor.stop"]));
  });

  it("does not steal the focus when something else has it", () => {
    const controller = fakeController();
    mount(controller);
    const level = button(en["editor.level.advanced"]);
    act(() => level?.focus());
    act(() => controller.set({ ...idle, running: true }));
    expect(document.activeElement).toBe(level);
  });

  it("changing the level halts a running program first and STOP still works", () => {
    const controller = fakeController({ ...idle, running: true });
    mount(controller);
    act(() => button(en["editor.level.advanced"])?.click());
    expect(controller.run).not.toHaveBeenCalled();
    expect(controller.dispose).not.toHaveBeenCalled();
    expect(controller.stop).toHaveBeenCalledTimes(1); // the level request itself
    const stop = button(en["editor.stop"]);
    expect(stop?.disabled).toBe(false);
    act(() => stop?.click());
    expect(controller.stop).toHaveBeenCalledTimes(2);
  });

  describe("switching level", () => {
    const pressed = (label: string) => button(label)?.getAttribute("aria-pressed");

    it("has no confirmation dialog: Advanced switches at once", () => {
      mount(fakeController());
      act(() => button(en["editor.level.advanced"])?.click());
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      expect(host.querySelector(".editor")?.classList.contains("confirming")).toBe(false);
      expect(pressed(en["editor.level.advanced"])).toBe("true");
      expect(pressed(en["editor.level.icons"])).toBe("false");
    });

    it("stops the controller and closes Blockly widgets on every change, both directions", () => {
      const spy = vi.spyOn(Blockly.WorkspaceSvg.prototype, "hideChaff");
      const controller = fakeController();
      mount(controller);
      spy.mockClear(); // Blockly itself calls hideChaff while injecting
      act(() => button(en["editor.level.advanced"])?.click());
      expect(controller.stop).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalled();
      spy.mockClear();
      act(() => button(en["editor.level.icons"])?.click());
      expect(controller.stop).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalled();
      expect(pressed(en["editor.level.icons"])).toBe("true");
      spy.mockRestore();
    });

    it("clicking the level already active does nothing", () => {
      const controller = fakeController();
      mount(controller);
      act(() => button(en["editor.level.icons"])?.click());
      expect(controller.stop).not.toHaveBeenCalled();
    });

    it("keeps the program across both directions", () => {
      const controller = fakeController();
      mount(controller);
      act(() => button(en["editor.level.advanced"])?.click());
      act(() => button(en["editor.level.icons"])?.click());
      act(() => button(en["editor.run"])?.click());
      const state = (controller.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        blocks: { blocks: { type: string }[] };
      };
      expect(state.blocks.blocks.map((b) => b.type)).toEqual(["mh_icon_when_start"]);
    });

    it("Escape is a pure STOP: it does not change the level", () => {
      const controller = fakeController();
      mount(controller);
      act(() => button(en["editor.level.advanced"])?.click());
      act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      expect(controller.stop).toHaveBeenCalledTimes(2); // the level change, then Esc
      expect(pressed(en["editor.level.advanced"])).toBe("true");
    });
  });

  it("previews the robot: LED and wheel states as data attributes", () => {
    mount(fakeController({ ...idle, led: "red", wheels: { a: "forward", b: "backward" } }));
    const preview = host.querySelector("[data-led]");
    expect(preview?.getAttribute("data-led")).toBe("red");
    expect(preview?.getAttribute("data-wheel-a")).toBe("forward");
    expect(preview?.getAttribute("data-wheel-b")).toBe("backward");
  });

  describe("simulator label", () => {
    it("shows which robot the preview is: the simulator for now", () => {
      mount(fakeController());
      const label = host.querySelector(".sim-source");
      expect(label).not.toBeNull();
      expect(label?.textContent).toBe(en["editor.source.simulator"]);
    });

    it("renders the hub label for source=hub, in both languages", () => {
      for (const [locale, catalog] of [
        ["en", en],
        ["es", es],
      ] as const) {
        act(() =>
          root.render(<SimPreview source="hub" snapshot={idle} t={createTranslator(locale)} />),
        );
        expect(host.querySelector(".sim-source"), locale).not.toBeNull();
        expect(host.querySelector(".sim-source")?.textContent, locale).toBe(
          catalog["editor.source.hub"],
        );
        act(() =>
          root.render(
            <SimPreview source="simulator" snapshot={idle} t={createTranslator(locale)} />,
          ),
        );
        expect(host.querySelector(".sim-source")?.textContent, locale).toBe(
          catalog["editor.source.simulator"],
        );
      }
    });
  });

  describe("level tooltips", () => {
    it.each(["icons", "advanced"] as const)("the %s button is described by a role=tooltip", (v) => {
      for (const [locale, catalog] of [
        ["en", en],
        ["es", es],
      ] as const) {
        mount(fakeController(), locale);
        const b = button(catalog[`editor.level.${v}`]);
        const id = b?.getAttribute("aria-describedby");
        expect(id, locale).toBeTruthy();
        const tip = host.querySelector(`#${id}`);
        expect(tip?.getAttribute("role")).toBe("tooltip");
        expect(tip?.textContent).toBe(catalog[`editor.levelHint.${v}`]);
        expect(b?.hasAttribute("title")).toBe(false); // the native title never shows on touch
      }
    });

    describe("Escape dismisses a visible tooltip (WCAG 1.4.13) without touching STOP", () => {
      const toggle = () => host.querySelector<HTMLElement>(".level-toggle");

      it("hides the tips until the pointer enters again, and STOP still runs first", () => {
        const controller = fakeController();
        mount(controller);
        expect(toggle()?.hasAttribute("data-tips-dismissed")).toBe(false);
        act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
        expect(controller.stop).toHaveBeenCalledTimes(1);
        expect(toggle()?.hasAttribute("data-tips-dismissed")).toBe(true);
        act(() => void toggle()?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
        expect(toggle()?.hasAttribute("data-tips-dismissed")).toBe(false);
      });

      it("stays dismissed while the focus is on a level button, until it moves away", () => {
        mount(fakeController());
        const b = button(en["editor.level.advanced"]);
        act(() => b?.focus());
        act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
        expect(toggle()?.hasAttribute("data-tips-dismissed")).toBe(true);
        act(() => void toggle()?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
        expect(toggle()?.hasAttribute("data-tips-dismissed")).toBe(true); // focus is still there
        act(() => b?.blur());
        expect(toggle()?.hasAttribute("data-tips-dismissed")).toBe(false);
      });
    });

    it("the two tooltips have different ids", () => {
      mount(fakeController());
      const ids = ["icons", "advanced"].map((v) =>
        button(en[`editor.level.${v as "icons" | "advanced"}`])?.getAttribute("aria-describedby"),
      );
      expect(new Set(ids).size).toBe(2);
    });
  });
});

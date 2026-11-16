// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../../content/i18n/en.json";
import es from "../../../../content/i18n/es.json";
import { createTranslator } from "../i18n.js";
import { EditorPage } from "./EditorPage.js";
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

  it("shows no visible text outside the Blockly area", () => {
    mount(fakeController());
    const chrome = host.querySelector(".editor-bar");
    expect(chrome?.textContent?.trim()).toBe("");
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
    act(() => button(en["editor.confirmAdvanced.confirm"])?.click());
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
    act(() => button(en["editor.confirmAdvanced.confirm"])?.click());
    expect(controller.run).not.toHaveBeenCalled();
    expect(controller.dispose).not.toHaveBeenCalled();
    expect(controller.stop).toHaveBeenCalledTimes(1); // the level request itself
    const stop = button(en["editor.stop"]);
    expect(stop?.disabled).toBe(false);
    act(() => stop?.click());
    expect(controller.stop).toHaveBeenCalledTimes(2);
  });

  describe("switching to the Advanced level asks first", () => {
    const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]');
    const pressed = (label: string) => button(label)?.getAttribute("aria-pressed");
    const key = (k: string, init: KeyboardEventInit = {}) =>
      act(
        () =>
          void document.activeElement?.dispatchEvent(
            new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }),
          ),
      );

    it("opens an accessible modal with the question, and changes nothing yet", () => {
      mount(fakeController());
      act(() => button(en["editor.level.advanced"])?.click());
      const d = dialog();
      expect(d?.getAttribute("aria-modal")).toBe("true");
      const title = host.querySelector(`#${d?.getAttribute("aria-labelledby")}`);
      expect(title?.textContent).toBe(en["editor.confirmAdvanced.title"]);
      expect(pressed(en["editor.level.icons"])).toBe("true");
      expect(pressed(en["editor.level.advanced"])).toBe("false");
    });

    it("focuses Cancel by default, and Cancel stays on Icons", () => {
      mount(fakeController());
      act(() => button(en["editor.level.advanced"])?.click());
      expect(document.activeElement).toBe(button(en["editor.confirmAdvanced.cancel"]));
      act(() => button(en["editor.confirmAdvanced.cancel"])?.click());
      expect(dialog()).toBeNull();
      expect(pressed(en["editor.level.icons"])).toBe("true");
    });

    it("Confirm switches to Advanced", () => {
      mount(fakeController());
      act(() => button(en["editor.level.advanced"])?.click());
      act(() => button(en["editor.confirmAdvanced.confirm"])?.click());
      expect(dialog()).toBeNull();
      expect(pressed(en["editor.level.advanced"])).toBe("true");
    });

    it("going back to Icons needs no confirmation", () => {
      mount(fakeController());
      act(() => button(en["editor.level.advanced"])?.click());
      act(() => button(en["editor.confirmAdvanced.confirm"])?.click());
      act(() => button(en["editor.level.icons"])?.click());
      expect(dialog()).toBeNull();
      expect(pressed(en["editor.level.icons"])).toBe("true");
    });

    it("traps the focus in Cancel, Confirm and STOP with Tab and Shift+Tab", () => {
      mount(fakeController());
      act(() => button(en["editor.level.advanced"])?.click());
      const cancel = button(en["editor.confirmAdvanced.cancel"]);
      const confirm = button(en["editor.confirmAdvanced.confirm"]);
      const stop = button(en["editor.stop"]);
      act(() => confirm?.focus());
      key("Tab"); // Confirm -> STOP (it stays reachable above the backdrop)
      expect(document.activeElement).toBe(stop);
      key("Tab"); // STOP -> wraps to Cancel
      expect(document.activeElement).toBe(cancel);
      key("Tab", { shiftKey: true }); // Cancel -> back to STOP
      expect(document.activeElement).toBe(stop);
      key("Tab", { shiftKey: true });
      expect(document.activeElement).toBe(confirm);
    });

    it("halts the robot as soon as the modal opens, and STOP stays usable behind it", () => {
      const controller = fakeController({ ...idle, running: true });
      mount(controller);
      act(() => button(en["editor.level.advanced"])?.click());
      expect(controller.stop).toHaveBeenCalledTimes(1);
      // the bar is raised above the backdrop (editor.css: .confirming .big-button.stop)
      expect(host.querySelector(".editor")?.classList.contains("confirming")).toBe(true);
      const stop = button(en["editor.stop"]);
      expect(stop?.disabled).toBe(false);
      act(() => stop?.click());
      expect(controller.stop).toHaveBeenCalledTimes(2);
    });

    it("gives the focus back to the level toggle however the modal closes", () => {
      const advanced = () => button(en["editor.level.advanced"]);
      mount(fakeController());
      act(() => advanced()?.click());
      act(() => button(en["editor.confirmAdvanced.cancel"])?.click());
      expect(document.activeElement).toBe(advanced());
      act(() => advanced()?.click());
      act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      expect(document.activeElement).toBe(advanced());
      act(() => advanced()?.click());
      act(() => button(en["editor.confirmAdvanced.confirm"])?.click());
      expect(document.activeElement).toBe(advanced());
    });

    it("Escape closes it as Cancel and is also a STOP", () => {
      const controller = fakeController();
      mount(controller);
      act(() => button(en["editor.level.advanced"])?.click());
      act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      expect(dialog()).toBeNull();
      expect(pressed(en["editor.level.icons"])).toBe("true");
      expect(controller.stop).toHaveBeenCalledTimes(2); // opening the modal, then Esc
    });

    it("Escape still stops a running program while the modal is open", () => {
      const controller = fakeController({ ...idle, running: true });
      mount(controller);
      act(() => button(en["editor.level.advanced"])?.click());
      expect(dialog()).not.toBeNull();
      act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      expect(controller.stop).toHaveBeenCalledTimes(2); // opening the modal, then Esc
      expect(dialog()).toBeNull();
    });
  });

  it("previews the robot: LED and wheel states as data attributes", () => {
    mount(fakeController({ ...idle, led: "red", wheels: { a: "forward", b: "backward" } }));
    const preview = host.querySelector("[data-led]");
    expect(preview?.getAttribute("data-led")).toBe("red");
    expect(preview?.getAttribute("data-wheel-a")).toBe("forward");
    expect(preview?.getAttribute("data-wheel-b")).toBe("backward");
  });
});

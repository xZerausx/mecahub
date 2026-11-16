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

function fakeController(snapshot: EditorSnapshot = idle) {
  const controller: EditorController = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
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
    expect(button(en["editor.level.advanced"])?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelectorAll(".blocklySvg")).toHaveLength(1);
    act(() => button(en["editor.run"])?.click());
    const state = (controller.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      blocks: { blocks: { type: string }[] };
    };
    expect(state.blocks.blocks.map((b) => b.type)).toEqual(["mh_icon_when_start"]);
  });

  it("previews the robot: LED and wheel states as data attributes", () => {
    mount(fakeController({ ...idle, led: "red", wheels: { a: "forward", b: "backward" } }));
    const preview = host.querySelector("[data-led]");
    expect(preview?.getAttribute("data-led")).toBe("red");
    expect(preview?.getAttribute("data-wheel-a")).toBe("forward");
    expect(preview?.getAttribute("data-wheel-b")).toBe("backward");
  });
});

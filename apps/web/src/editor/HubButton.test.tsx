// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../../content/i18n/en.json";
import es from "../../../../content/i18n/es.json";
import { createTranslator } from "../i18n.js";
import { HubButton, type HubButtonProps } from "./HubButton.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const mount = (props: Partial<HubButtonProps> = {}, locale: "en" | "es" = "en") => {
  const onUseHub = vi.fn();
  const onUseSimulator = vi.fn();
  act(() =>
    root.render(
      <HubButton
        source="simulator"
        connection="connected"
        available
        onUseHub={onUseHub}
        onUseSimulator={onUseSimulator}
        t={createTranslator(locale)}
        {...props}
      />,
    ),
  );
  return { onUseHub, onUseSimulator, button: host.querySelector("button") as HTMLButtonElement };
};

describe("HubButton", () => {
  it("on the simulator it offers to connect the robot and calls onUseHub from the click itself", () => {
    const { button, onUseHub, onUseSimulator } = mount();
    expect(button.getAttribute("aria-label")).toBe(en["editor.hub.connect"]);
    act(() => button.click());
    expect(onUseHub).toHaveBeenCalledTimes(1);
    expect(onUseSimulator).not.toHaveBeenCalled();
  });

  it.each(["connected", "failed", "dropped"] as const)(
    "on the hub (%s) it offers to go back to the simulator",
    (connection) => {
      const { button, onUseHub, onUseSimulator } = mount({ source: "hub", connection });
      expect(button.getAttribute("aria-label")).toBe(en["editor.hub.disconnect"]);
      act(() => button.click());
      expect(onUseSimulator).toHaveBeenCalledTimes(1);
      expect(onUseHub).not.toHaveBeenCalled();
    },
  );

  it("while connecting it offers to cancel, is visibly animated, and goes back to the simulator", () => {
    const { button, onUseSimulator } = mount({ source: "hub", connection: "connecting" });
    expect(button.getAttribute("aria-label")).toBe(en["editor.hub.cancel"]);
    expect(button.getAttribute("data-connecting")).not.toBeNull();
    expect(button.getAttribute("aria-busy")).toBe("true");
    act(() => button.click());
    expect(onUseSimulator).toHaveBeenCalledTimes(1);
  });

  it("where Bluetooth is not available it is aria-disabled (still focusable) and explains why", () => {
    const { button, onUseHub } = mount({ available: false });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false); // focusable: keyboard and screen-reader users reach the note
    const id = button.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const note = host.querySelector(`#${id}`);
    expect(note?.textContent).toBe(en["editor.hub.unsupported"]);
    act(() => button.click());
    expect(onUseHub).not.toHaveBeenCalled();
  });

  it("speaks the cancel label in Spanish", () => {
    const { button } = mount({ source: "hub", connection: "connecting" }, "es");
    expect(button.getAttribute("aria-label")).toBe(es["editor.hub.cancel"]);
  });

  it("has no explanation to read when Bluetooth works", () => {
    const { button } = mount();
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(host.querySelector(".hub-note")).toBeNull();
  });

  it("speaks Spanish too", () => {
    const { button } = mount({}, "es");
    expect(button.getAttribute("aria-label")).toBe(es["editor.hub.connect"]);
  });
});

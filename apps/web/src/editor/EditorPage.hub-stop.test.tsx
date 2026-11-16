// @vitest-environment jsdom
import { SimulatedHub, defaultMoveHubConfig } from "@mecahub/simulator";
import { bridgeFakeBluetooth } from "@mecahub/simulator/testing";
import { FakeBluetooth } from "@mecahub/transport/testing";
import { WebBleTransport } from "@mecahub/transport/web";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../../content/i18n/en.json";
import { createTranslator } from "../i18n.js";
import { EditorPage } from "./EditorPage.js";
import { STOP_BUDGET_MS, createEditorController } from "./editor-controller.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mandatory (CLAUDE.md): STOP < 200 ms, always, also with a real hub as the device. Here the page's
// own STOP button and the Esc key, with the Web Bluetooth adapter over a scripted navigator.bluetooth
// bridged to a simulated hub (30 ms of write latency). Motors are measured at the hub. What a real
// hub does on StartPower 127, and how fast, is supuesto, TODO(hw): see docs/hardware-checklist.md.
afterEach(() => vi.useRealTimers());

const forward = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: "mh_icon_when_start",
        id: "h",
        next: { block: { type: "mh_icon_forward", id: "f", fields: { STEPS: 9 } } },
      },
    ],
  },
  variables: [],
};

async function onTheHub() {
  const hub = // A link loss must not be what stops the motors here: only the STOP frames count.
    new SimulatedHub({ ...defaultMoveHubConfig(), stopMotorsOnLinkLoss: false });
  const bluetooth = new FakeBluetooth();
  bridgeFakeBluetooth(bluetooth, hub, { writeLatencyMs: 30 });
  const controller = createEditorController({
    createHubTransport: () => new WebBleTransport(bluetooth),
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  // Real Blockly is injected in jsdom: slow, and not STOP latency, so before the fake clock starts.
  act(() =>
    root.render(<EditorPage controller={controller} locale="en" t={createTranslator("en")} />),
  );
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(500); // the page connected the simulator
  act(() =>
    host
      .querySelector<HTMLButtonElement>(`button[aria-label="${en["editor.hub.connect"]}"]`)
      ?.click(),
  );
  await vi.advanceTimersByTimeAsync(2000);
  expect(controller.getSnapshot()).toMatchObject({ source: "hub", connection: "connected" });
  const result = controller.run(forward);
  await vi.advanceTimersByTimeAsync(800);
  const moving = () => hub.motorState(0).running || hub.motorState(1).running;
  expect(moving()).toBe(true);
  const cleanup = () => {
    act(() => root.unmount());
    controller.dispose();
    host.remove();
  };
  return { host, moving, result, cleanup };
}

describe("STOP with a real hub as the device", () => {
  it("the STOP button halts every motor within STOP_BUDGET_MS", { timeout: 30_000 }, async () => {
    const { host, moving, result, cleanup } = await onTheHub();
    const t0 = Date.now();
    act(() =>
      host.querySelector<HTMLButtonElement>(`button[aria-label="${en["editor.stop"]}"]`)?.click(),
    );
    while (moving() && Date.now() - t0 < 1000) await vi.advanceTimersByTimeAsync(5);
    expect(moving()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(STOP_BUDGET_MS);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe("stopped");
    cleanup();
  });

  it("Esc halts every motor within STOP_BUDGET_MS", { timeout: 30_000 }, async () => {
    const { moving, result, cleanup } = await onTheHub();
    const t0 = Date.now();
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    while (moving() && Date.now() - t0 < 1000) await vi.advanceTimersByTimeAsync(5);
    expect(moving()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(STOP_BUDGET_MS);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe("stopped");
    cleanup();
  });
});

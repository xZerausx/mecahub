// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../../content/i18n/en.json";
import { createTranslator } from "../i18n.js";
import { EditorPage } from "./EditorPage.js";
import { STOP_BUDGET_MS, createEditorController } from "./editor-controller.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mandatory (CLAUDE.md): STOP < 200 ms, always. Opening the "switch level" modal is a stop too,
// because the modal's backdrop must never leave a running robot without a reachable STOP.
afterEach(() => vi.useRealTimers());

describe("opening the level modal while a program runs", () => {
  it("halts every motor within STOP_BUDGET_MS", async () => {
    vi.useFakeTimers();
    const controller = createEditorController({ simWriteLatencyMs: 30 });
    const connecting = controller.connect();
    await vi.advanceTimersByTimeAsync(300);
    await connecting;
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
    const result = controller.run(forward);
    await vi.advanceTimersByTimeAsync(800);
    const moving = () =>
      controller.getSnapshot().wheels.a !== "stopped" ||
      controller.getSnapshot().wheels.b !== "stopped";
    expect(moving()).toBe(true);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(<EditorPage controller={controller} locale="en" t={createTranslator("en")} />),
    );
    const t0 = Date.now();
    act(() =>
      host
        .querySelector<HTMLButtonElement>(`button[aria-label="${en["editor.level.advanced"]}"]`)
        ?.click(),
    );
    while (moving() && Date.now() - t0 < 1000) await vi.advanceTimersByTimeAsync(5);
    expect(moving()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(STOP_BUDGET_MS);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe("stopped");
    act(() => root.unmount());
    controller.dispose();
    host.remove();
  });
});

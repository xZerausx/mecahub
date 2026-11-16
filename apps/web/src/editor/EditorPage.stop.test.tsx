// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../../../../content/i18n/en.json";
import { createTranslator } from "../i18n.js";
import { EditorPage } from "./EditorPage.js";
import { STOP_BUDGET_MS, createEditorController } from "./editor-controller.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mandatory (CLAUDE.md): STOP < 200 ms, always. Switching level is a stop too: a change of
// level must never leave a running robot behind.
afterEach(() => vi.useRealTimers());

describe("switching level while a program runs", () => {
  it("halts every motor within STOP_BUDGET_MS", { timeout: 30_000 }, async () => {
    // Real Blockly is injected in jsdom: that is slow under parallel load and is not STOP latency,
    // so it happens before the fake clock starts and the timeout is generous.
    const controller = createEditorController({ simWriteLatencyMs: 30 });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(<EditorPage controller={controller} locale="en" t={createTranslator("en")} />),
    );
    vi.useFakeTimers();
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

describe("switching level while idle", () => {
  // Blockly re-injects in the same click: a long task. If a STOP write was still in flight it would
  // miss its 150 ms deadline and the transport would declare the link dead. So the STOP frames must
  // be out before the level (and so the re-inject) changes, and the link must survive.
  it(
    "sends the STOP frames before the level changes, and keeps the link",
    { timeout: 30_000 },
    async () => {
      const controller = createEditorController({ simWriteLatencyMs: 30 });
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      act(() =>
        root.render(<EditorPage controller={controller} locale="en" t={createTranslator("en")} />),
      );
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(500); // the page connected the simulator
      expect(controller.getSnapshot().connection).toBe("connected");
      const framesBefore = controller.sentFrames();
      const editor = host.querySelector<HTMLElement>(".editor");
      act(() =>
        host
          .querySelector<HTMLButtonElement>(`button[aria-label="${en["editor.level.advanced"]}"]`)
          ?.click(),
      );
      let framesWhenLevelChanged: number | undefined;
      for (let ms = 0; ms < 1000 && framesWhenLevelChanged === undefined; ms += 5) {
        await vi.advanceTimersByTimeAsync(5);
        if (editor?.getAttribute("data-level") === "advanced") {
          framesWhenLevelChanged = controller.sentFrames();
        }
      }
      expect(framesWhenLevelChanged).toBeDefined();
      expect(framesWhenLevelChanged).toBeGreaterThan(framesBefore); // STOP went out first
      expect(controller.getSnapshot().connection).toBe("connected"); // no link drop
      act(() => root.unmount());
      controller.dispose();
      host.remove();
    },
  );
});

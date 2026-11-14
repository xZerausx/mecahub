import { TransportError } from "@mecahub/transport";
import { describe, expect, it } from "vitest";
import { LabError, type LabSnapshot } from "./lab-types.js";
import {
  COLOR_CHOICES,
  canMeasure,
  canStartLinkLoss,
  copyToClipboard,
  installStopKey,
  isStopKey,
  labErrorKey,
  needsLeaveGuard,
} from "./lab-ui.js";
import en from "../../../../../content/i18n/dev.en.json";
import es from "../../../../../content/i18n/dev.es.json";

const snapshot = (patch: Partial<LabSnapshot> = {}): LabSnapshot => ({
  mode: "simulator",
  webBluetoothAvailable: false,
  connection: "connected",
  ready: true,
  timings: {},
  hubName: undefined,
  firmware: undefined,
  devices: [],
  hasAb: false,
  motors: [],
  tilt: undefined,
  color: undefined,
  distance: undefined,
  button: undefined,
  battery: undefined,
  led: undefined,
  stop: { status: "idle" },
  diagnostics: [],
  measurements: {},
  running: undefined,
  lastError: undefined,
  ...patch,
});

describe("isStopKey", () => {
  it("is the Escape key only", () => {
    expect(isStopKey({ key: "Escape" })).toBe(true);
    expect(isStopKey({ key: "Enter" })).toBe(false);
    expect(isStopKey({ key: " " })).toBe(false);
  });

  it("ignores key repeat: holding Escape is one press", () => {
    expect(isStopKey({ key: "Escape", repeat: true })).toBe(false);
    expect(isStopKey({ key: "Escape", repeat: false })).toBe(true);
  });
});

describe("installStopKey", () => {
  function fakeTarget() {
    const calls: { type: string; capture: boolean | undefined; remove: boolean }[] = [];
    let handler: ((e: { key: string; repeat?: boolean }) => void) | undefined;
    return {
      calls,
      press: (e: { key: string; repeat?: boolean }) => handler?.(e),
      target: {
        addEventListener(
          type: "keydown",
          l: (e: { key: string; repeat?: boolean }) => void,
          capture: boolean,
        ) {
          handler = l;
          calls.push({ type, capture, remove: false });
        },
        removeEventListener(type: "keydown", _l: unknown, capture: boolean) {
          handler = undefined;
          calls.push({ type, capture, remove: true });
        },
      },
    };
  }

  it("listens in the capture phase, so a focused control cannot swallow Escape", () => {
    const { target, calls } = fakeTarget();
    installStopKey(target, () => undefined);
    expect(calls[0]).toEqual({ type: "keydown", capture: true, remove: false });
  });

  it("stops once per Escape press, not on repeats or other keys, and cleans up", () => {
    const { target, press, calls } = fakeTarget();
    let stops = 0;
    const off = installStopKey(target, () => stops++);
    press({ key: "Escape" });
    press({ key: "Escape", repeat: true });
    press({ key: "Enter" });
    expect(stops).toBe(1);
    off();
    expect(calls.at(-1)).toEqual({ type: "keydown", capture: true, remove: true });
  });
});

describe("needsLeaveGuard", () => {
  const moving = { port: 0, position: 0, commandedSpeed: 30 };

  it("is off for an idle lab", () => {
    expect(needsLeaveGuard(snapshot())).toBe(false);
    expect(needsLeaveGuard(snapshot({ motors: [{ ...moving, commandedSpeed: 0 }] }))).toBe(false);
  });

  it("is on while a motor has a non-zero commanded speed", () => {
    expect(needsLeaveGuard(snapshot({ motors: [moving] }))).toBe(true);
  });

  it("is on while a link-loss test waits for its answer", () => {
    const pending = {
      phase: "awaiting-observation" as const,
      port: 0,
      speedPct: 30,
      droppedAtMs: 1,
      observation: undefined,
      answeredAfterMs: undefined,
      derived: undefined,
      reconnected: undefined,
      stopAfterReconnect: undefined,
    };
    expect(
      needsLeaveGuard(
        snapshot({ running: "stopOnLinkLoss", measurements: { stopOnLinkLoss: pending } }),
      ),
    ).toBe(true);
  });
});

describe("copyToClipboard", () => {
  it("rejects, without throwing, when the browser has no clipboard", async () => {
    let promise: Promise<void> | undefined;
    expect(() => (promise = copyToClipboard({}, "text"))).not.toThrow();
    await expect(promise).rejects.toBeInstanceOf(Error);
  });

  it("writes the text when there is one", async () => {
    const written: string[] = [];
    await copyToClipboard(
      { clipboard: { writeText: (t: string) => (written.push(t), Promise.resolve()) } },
      "abc",
    );
    expect(written).toEqual(["abc"]);
  });

  it("turns a synchronous throw of the clipboard into a rejection", async () => {
    const nav = {
      clipboard: {
        writeText: (): Promise<void> => {
          throw new Error("denied");
        },
      },
    };
    await expect(copyToClipboard(nav, "x")).rejects.toThrow("denied");
  });
});

describe("canStartLinkLoss", () => {
  it("needs the safety box ticked", () => {
    expect(canStartLinkLoss(false, snapshot())).toBe(false);
    expect(canStartLinkLoss(true, snapshot())).toBe(true);
  });

  it("needs a ready hub and nothing else running", () => {
    expect(canStartLinkLoss(true, snapshot({ ready: false }))).toBe(false);
    expect(canStartLinkLoss(true, snapshot({ running: "writeLatency" }))).toBe(false);
  });
});

describe("canMeasure", () => {
  it("is true for a ready, idle hub", () => {
    expect(canMeasure(snapshot())).toBe(true);
    expect(canMeasure(snapshot({ ready: false }))).toBe(false);
    expect(canMeasure(snapshot({ running: "feedback" }))).toBe(false);
  });
});

describe("labErrorKey", () => {
  it("maps every LabError code to a message in both catalogs", () => {
    for (const code of [
      "not-connected",
      "busy",
      "unsupported",
      "no-motor",
      "not-confirmed",
      "no-observation",
      "command-failed",
    ] as const) {
      const key = labErrorKey(new LabError(code));
      expect(key).toBe(`dev.lab.error.${code}`);
      expect(key in en).toBe(true);
      expect(key in es).toBe(true);
    }
  });

  it("uses the connect messages for transport errors and a generic one otherwise", () => {
    expect(labErrorKey(new TransportError("cancelled"))).toBe("dev.connect.error.cancelled");
    expect(labErrorKey(new Error("x"))).toBe("dev.connect.error.unknown");
  });
});

describe("COLOR_CHOICES", () => {
  it("lists the LWP3 color table: ids 0..10 and 255, each with a label", () => {
    expect(COLOR_CHOICES.map(([id]) => id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 255]);
    for (const [, key] of COLOR_CHOICES) expect(key in en).toBe(true);
  });
});

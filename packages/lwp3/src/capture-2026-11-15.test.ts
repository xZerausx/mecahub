import { describe, expect, it } from "vitest";
import { decode } from "./decode.js";
import type { Lwp3Message } from "./messages.js";
import { loadCapture, type CaptureFrame } from "./test-support/fixtures.js";

// Second real Move Hub capture: the lab page (Chrome / Web Bluetooth), 2026-11-15. Every vector
// below is 'capturado': fixtures/2026-11-15-lab-session.txt. The `# result:` and `# operator:`
// lines of that file are notes, skipped by the parser.
const frames = loadCapture("2026-11-15-lab-session.txt");
const rx = frames.filter((f) => f.dir === "rx");
const tx = frames.filter((f) => f.dir === "tx");
const hex = (f: CaptureFrame): string =>
  Array.from(f.bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
const indexOfRx = (h: string, from = 0): number => {
  const i = frames.findIndex((f, n) => n >= from && f.dir === "rx" && hex(f) === h);
  if (i < 0) throw new Error(`no rx ${h}`);
  return i;
};
const indexOfTx = (h: string): number => {
  const i = frames.findIndex((f) => f.dir === "tx" && hex(f) === h);
  if (i < 0) throw new Error(`no tx ${h}`);
  return i;
};

describe("capture 2026-11-15 (lab session): rx frames", () => {
  it("every rx frame decodes: no error", () => {
    expect(rx.length).toBeGreaterThan(1000);
    for (const f of rx)
      expect(decode(f.bytes), `+${f.at}ms ${hex(f)}`).not.toHaveProperty("kind", "error");
  });

  it("each notification carries exactly one complete frame", () => {
    for (const f of rx) expect(f.bytes[0], `+${f.at}ms`).toBe(f.bytes.length);
  });

  it("connect: the attached-IO burst follows the app's first write, 9 frames in the 2026-11-13 order", () => {
    const first = frames[0]!;
    expect(hex(first)).toBe("05 00 01 03 05");
    expect(first.dir).toBe("tx");
    const burst = frames.slice(1, 10);
    expect(burst.every((f) => f.dir === "rx" && f.bytes[2] === 0x04)).toBe(true);
    expect(burst.map((f) => f.bytes[3])).toEqual([
      0x00, 0x01, 0x03, 0x10, 0x32, 0x3a, 0x3b, 0x3c, 0x46,
    ]);
    expect(burst[0]!.at - first.at).toBeLessThanOrEqual(5);
  });

  it("firmware version reply 0x20000017 decodes (BCD) as 2.0.0.17", () => {
    const m = decode(frames[indexOfRx("09 00 01 03 06 17 00 00 20")]!.bytes);
    expect(m).toEqual({
      type: "hubProperty",
      operation: "update",
      property: "firmwareVersion",
      value: { raw: 0x20000017, bcd: true, major: 2, minor: 0, bugfix: 0, build: 17 },
    });
  });

  it("enableUpdates battery is answered by an immediate Update, with no other battery request in between", () => {
    const req = indexOfTx("05 00 01 06 02");
    const next = frames.findIndex(
      (f, n) => n > req && f.dir === "rx" && f.bytes[2] === 0x01 && f.bytes[3] === 0x06,
    );
    expect(frames[next]!.at - frames[req]!.at).toBeLessThan(100);
    const between = frames
      .slice(req + 1, next)
      .filter((f) => f.dir === "tx" && f.bytes[2] === 0x01 && f.bytes[3] === 0x06);
    expect(between).toEqual([]);
    expect(decode(frames[next]!.bytes)).toEqual({
      type: "hubProperty",
      operation: "update",
      property: "batteryPercent",
      value: 0x48,
    });
  });

  it("enableUpdates button is answered by an immediate Update (released)", () => {
    const req = indexOfTx("05 00 01 02 02");
    const at = indexOfRx("06 00 01 02 06 00", req);
    expect(frames[at]!.at - frames[req]!.at).toBeLessThan(100);
    expect(decode(frames[at]!.bytes)).toEqual({
      type: "hubProperty",
      operation: "update",
      property: "button",
      value: false,
    });
  });

  it("input format setup: 0x47 echo first, then the current value 0x45 (tilt, motors, color & distance)", () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["0A 00 47 3A 00 01 00 00 00 01", "06 00 45 3A 05 B0"],
      ["0A 00 47 00 02 01 00 00 00 01", "08 00 45 00 FF FF FF FF"],
      ["0A 00 47 01 02 01 00 00 00 01", "08 00 45 01 00 00 00 00"],
      ["0A 00 47 03 08 01 00 00 00 01", "08 00 45 03 FF 09 FF 00"],
    ];
    for (const [echo, value] of pairs) {
      const e = indexOfRx(echo);
      expect(frames[indexOfRx(value, e)]!.at, echo).toBeGreaterThanOrEqual(frames[e]!.at);
    }
    expect(decode(frames[indexOfRx("0A 00 47 3A 00 01 00 00 00 01")]!.bytes)).toEqual({
      type: "portInputFormat",
      port: 0x3a,
      mode: 0,
      deltaInterval: 1,
      notify: true,
    });
    // At rest the color & distance sensor reports `FF 09 FF 00` in mode 8 (color 255 = none).
    expect(decode(frames[indexOfRx("08 00 45 03 FF 09 FF 00")]!.bytes)).toEqual({
      type: "portValue",
      port: 0x03,
      raw: Uint8Array.of(0xff, 0x09, 0xff, 0x00),
    });
  });

  it("LED (0x32) setup mode 0 is answered by 0x47 only: no 0x45 follows, and the direct write draws no reply", () => {
    const setup = indexOfTx("0A 00 41 32 00 01 00 00 00 00");
    const echo = indexOfRx("0A 00 47 32 00 01 00 00 00 00", setup);
    const write = indexOfTx("08 00 81 32 10 51 00 03");
    expect(write).toBeLessThan(echo);
    // Nothing for port 0x32 (0x45, 0x82, 0x05 error) arrives after the echo until the next LED write.
    const nextLed = indexOfTx("08 00 81 32 10 51 00 05");
    const forPort32 = frames
      .slice(echo + 1, nextLed)
      .filter((f) => f.dir === "rx" && f.bytes[3] === 0x32);
    expect(forPort32).toEqual([]);
    const errors = frames
      .slice(write, nextLed)
      .filter((f) => f.dir === "rx" && f.bytes[2] === 0x05);
    expect(errors).toEqual([]);
  });

  it("StartSpeedForTime with feedback: 0x82 flags 0x01 right after the command, 0x0A (completed + idle) at the end", () => {
    const cmd = indexOfTx("0C 00 81 00 11 09 E8 03 64 64 7F 00");
    const started = indexOfRx("05 00 82 00 01", cmd);
    const done = indexOfRx("05 00 82 00 0A", started);
    expect(frames[started]!.at - frames[cmd]!.at).toBeLessThan(150);
    // E8 03 = 1000 ms: the end comes about one second after the start.
    expect(frames[done]!.at - frames[started]!.at).toBeGreaterThan(1000);
    expect(frames[done]!.at - frames[started]!.at).toBeLessThan(1300);
    const flags = (m: Lwp3Message | { kind: "error" }) =>
      "type" in m && m.type === "portOutputFeedback" ? m.ports[0] : undefined;
    expect(flags(decode(frames[started]!.bytes))).toMatchObject({
      port: 0,
      flags: 0x01,
      bufferEmptyInProgress: true,
      idle: false,
    });
    expect(flags(decode(frames[done]!.bytes))).toMatchObject({
      port: 0,
      flags: 0x0a,
      bufferEmptyCompleted: true,
      idle: true,
    });
  });

  it("multi-message write: only the first message of a two-message write is answered", () => {
    const w = indexOfTx("05 00 01 06 05 05 00 01 01 05");
    const nextTx = frames.findIndex((f, n) => n > w && f.dir === "tx");
    const after = frames.slice(w + 1, nextTx < 0 ? undefined : nextTx);
    // The battery request (first message) is answered ...
    expect(after.some((f) => f.dir === "rx" && f.bytes[2] === 0x01 && f.bytes[3] === 0x06)).toBe(
      true,
    );
    // ... the advertising-name request (second message) is not.
    expect(after.some((f) => f.dir === "rx" && f.bytes[2] === 0x01 && f.bytes[3] === 0x01)).toBe(
      false,
    );
  });

  it("motor speed: 100 % for 1000 ms covers 1105 degrees (position deltas), 50 % covers 831", () => {
    const pos = (from: number, to: number) => {
      const i32 = (f: CaptureFrame) =>
        new DataView(f.bytes.buffer, f.bytes.byteOffset).getInt32(4, true);
      const p = frames
        .slice(from, to)
        .filter(
          (f) =>
            f.dir === "rx" && f.bytes[2] === 0x45 && f.bytes[3] === 0x00 && f.bytes.length === 8,
        );
      return (
        i32(p[p.length - 1]!) -
        i32(
          frames
            .slice(0, from)
            .filter(
              (f) =>
                f.dir === "rx" &&
                f.bytes[2] === 0x45 &&
                f.bytes[3] === 0x00 &&
                f.bytes.length === 8,
            )
            .at(-1)!,
        )
      );
    };
    const a = indexOfTx("0C 00 81 00 11 09 E8 03 64 64 7F 00");
    const b = indexOfTx("0C 00 81 00 11 09 E8 03 32 64 7F 00");
    expect(pos(a, b)).toBe(1105);
    expect(
      pos(
        b,
        // up to the next tool's first write (the motor had stopped by then)
        frames.findIndex((f, i) => i > b && f.dir === "tx"),
      ),
    ).toBe(831);
  });
});

describe("capture 2026-11-15: tx frames and notes", () => {
  it("every tx frame is a single message that decodes (multi-message write aside)", () => {
    expect(tx.length).toBeGreaterThan(50);
    for (const f of tx) {
      if (f.bytes[0] !== f.bytes.length) continue; // the two-message write
      expect(decode(f.bytes), `+${f.at}ms`).not.toHaveProperty("kind", "error");
    }
    expect(tx.filter((f) => f.bytes[0] !== f.bytes.length).map(hex)).toEqual([
      "05 00 01 06 05 05 00 01 01 05",
    ]);
  });
});

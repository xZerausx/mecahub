import { describe, expect, it } from "vitest";
import { decodeHeader } from "./header.js";
import type { PortOutputCommand, PortOutputCommandMessage } from "./messages.js";
import { decodePortOutputCommand, encodePortOutputCommand } from "./port-output.js";

const b = (...bytes: number[]) => Uint8Array.of(...bytes);

function payloadOf(frame: Uint8Array): Uint8Array {
  const h = decodeHeader(frame);
  if ("kind" in h) throw new Error("bad frame");
  return h.payload;
}

type Msg = Omit<PortOutputCommandMessage, "type">;
interface Vector {
  name: string;
  origin: string;
  msg: Msg;
  bytes: Uint8Array;
}

const none = { acc: false, dec: false };
const now = { startup: "immediate", completion: "feedback" } as const;
const mk = (port: number, command: PortOutputCommand, o: Partial<Msg> = {}): Msg => ({
  port,
  ...now,
  ...o,
  command,
});

// Layout (doc 3.26): [len, 0, 0x81, port, startup<<4 | completion, subCommand, payload...].
// Startup/completion nibbles: pybricksdev bytecodes.py:1053-1061 (IMMEDIATE 0x10, FEEDBACK 0x01),
// node-poweredup portoutputcommand.ts:22-26 (feedback 0x01, interrupt 0x10). The sub-command
// payloads: node-poweredup tachomotor.ts:111-147 and absolutemotor.ts:61, pylgbst
// peripherals.py:437-517 (virtual ports use subcmd+1 at :388-390).
const D = "derivado del layout: doc 3.26/3.27";

const stopNow = { startup: "immediate", completion: "none" } as const;

const startPower: Vector[] = [
  {
    name: "brake (127), port 0, immediate, no feedback: the STOP command",
    origin: `${D}: doc 3.27.1 (127 = BRAKE); pybricksdev bytecodes.py:1035 (START_POWER = 0x01), pylgbst peripherals.py:363,380-384 (127 passes through)`,
    msg: mk(0, { sub: "startPower", power: 127 }, stopNow),
    bytes: b(0x07, 0x00, 0x81, 0x00, 0x10, 0x01, 0x7f),
  },
  {
    name: "float (0)",
    origin: `${D}: doc 3.27.1 (0 = FLOAT)`,
    msg: mk(0, { sub: "startPower", power: 0 }, stopNow),
    bytes: b(0x07, 0x00, 0x81, 0x00, 0x10, 0x01, 0x00),
  },
  {
    name: "power -50 is a two's complement i8",
    origin: `${D}: doc 3.27.1 (Int8, -100..-1 counter-clockwise)`,
    msg: mk(1, { sub: "startPower", power: -50 }, stopNow),
    bytes: b(0x07, 0x00, 0x81, 0x01, 0x10, 0x01, 0xce),
  },
  {
    name: "power 100 with feedback requested",
    origin: `${D}: doc 3.27.1`,
    msg: mk(0, { sub: "startPower", power: 100 }),
    bytes: b(0x07, 0x00, 0x81, 0x00, 0x11, 0x01, 0x64),
  },
];

const startPower2: Vector[] = [
  {
    name: "virtual AB (test port 0x10), 50 / -50",
    origin: `${D}: doc 3.27.2 (synchronized only); pybricksdev bytecodes.py:1036 (START_POWER_2 = 0x02), pylgbst peripherals.py:364,402-410 (grouped power on virtual ports)`,
    msg: mk(0x10, { sub: "startPower2", power1: 50, power2: -50 }, stopNow),
    bytes: b(0x08, 0x00, 0x81, 0x10, 0x10, 0x02, 0x32, 0xce),
  },
  {
    name: "brake on both motors",
    origin: `${D}: doc 3.27.2 (same Power values as 0x01)`,
    msg: mk(0x10, { sub: "startPower2", power1: 127, power2: 127 }, stopNow),
    bytes: b(0x08, 0x00, 0x81, 0x10, 0x10, 0x02, 0x7f, 0x7f),
  },
];

const startSpeed: Vector[] = [
  {
    name: "port 0, speed 50, power 100, no profile",
    origin: `${D}; node-poweredup tachomotor.ts:120, pylgbst peripherals.py:445-452 agree`,
    msg: mk(0, { sub: "startSpeed", speed: 50, maxPower: 100, useProfile: none }),
    bytes: b(0x09, 0x00, 0x81, 0x00, 0x11, 0x07, 0x32, 0x64, 0x00),
  },
  {
    name: "negative speed is a two's complement i8",
    origin: `${D}; same layout`,
    msg: mk(0, { sub: "startSpeed", speed: -50, maxPower: 100, useProfile: none }),
    bytes: b(0x09, 0x00, 0x81, 0x00, 0x11, 0x07, 0xce, 0x64, 0x00),
  },
  {
    name: "speed 126 is hold, acc+dec profile",
    origin: `${D}; useProfile bits: node-poweredup tachomotor.ts:154-163 (acc 0x01, dec 0x02)`,
    msg: mk(0, {
      sub: "startSpeed",
      speed: 126,
      maxPower: 100,
      useProfile: { acc: true, dec: true },
    }),
    bytes: b(0x09, 0x00, 0x81, 0x00, 0x11, 0x07, 0x7e, 0x64, 0x03),
  },
  {
    name: "acc only is 0x01, dec only is 0x02",
    origin: `${D}; node-poweredup tachomotor.ts:154-163`,
    msg: mk(1, {
      sub: "startSpeed",
      speed: 1,
      maxPower: 0,
      useProfile: { acc: false, dec: true },
    }),
    bytes: b(0x09, 0x00, 0x81, 0x01, 0x11, 0x07, 0x01, 0x00, 0x02),
  },
  {
    name: "buffer + no completion is byte 0x00",
    origin: `${D}; startup in the high nibble: pybricksdev bytecodes.py:1053-1061`,
    msg: mk(
      0,
      { sub: "startSpeed", speed: 50, maxPower: 100, useProfile: none },
      { startup: "buffer", completion: "none" },
    ),
    bytes: b(0x09, 0x00, 0x81, 0x00, 0x00, 0x07, 0x32, 0x64, 0x00),
  },
  {
    name: "immediate + no completion is 0x10, buffer + feedback is 0x01",
    origin: `${D}; pybricksdev bytecodes.py:1053-1061, node-poweredup portoutputcommand.ts:22-26`,
    msg: mk(
      0,
      { sub: "startSpeed", speed: 50, maxPower: 100, useProfile: none },
      { startup: "buffer", completion: "feedback" },
    ),
    bytes: b(0x09, 0x00, 0x81, 0x00, 0x01, 0x07, 0x32, 0x64, 0x00),
  },
];

const startSpeed2: Vector[] = [
  {
    name: "virtual AB (test port 0x10), 50 / -50",
    origin: `${D}; node-poweredup tachomotor.ts:118, pybricksdev bytecodes.py:1040 (START_SPEED_2 = 0x08), pylgbst peripherals.py:388-390 (subcmd+1 on virtual ports)`,
    msg: mk(0x10, {
      sub: "startSpeed2",
      speed1: 50,
      speed2: -50,
      maxPower: 100,
      useProfile: none,
    }),
    bytes: b(0x0a, 0x00, 0x81, 0x10, 0x11, 0x08, 0x32, 0xce, 0x64, 0x00),
  },
];

const forTime: Vector[] = [
  {
    name: "1000 ms, 50, power 100, brake",
    origin: `${D}; node-poweredup tachomotor.ts:113-115 (u16 LE at 1, speed, maxPower, brake, profile), pylgbst peripherals.py:462-472`,
    msg: mk(0, {
      sub: "startSpeedForTime",
      time: 1000,
      speed: 50,
      maxPower: 100,
      endState: 127,
      useProfile: none,
    }),
    bytes: b(0x0c, 0x00, 0x81, 0x00, 0x11, 0x09, 0xe8, 0x03, 0x32, 0x64, 0x7f, 0x00),
  },
  {
    name: "max time 32767 (Int16 in the doc), float end state",
    origin: `${D}: Time is Int16 0..MAX_INT16 (refs write it as u16; same bytes in range)`,
    msg: mk(0, {
      sub: "startSpeedForTime",
      time: 0x7fff,
      speed: -100,
      maxPower: 0,
      endState: 0,
      useProfile: none,
    }),
    bytes: b(0x0c, 0x00, 0x81, 0x00, 0x11, 0x09, 0xff, 0x7f, 0x9c, 0x00, 0x00, 0x00),
  },
];

const forDegrees: Vector[] = [
  {
    name: "360 degrees, 50, power 100, brake",
    origin: `${D}; node-poweredup tachomotor.ts:147-149 (u32 LE), pylgbst peripherals.py:507-517`,
    msg: mk(0, {
      sub: "startSpeedForDegrees",
      degrees: 360,
      speed: 50,
      maxPower: 100,
      endState: 127,
      useProfile: none,
    }),
    bytes: b(0x0e, 0x00, 0x81, 0x00, 0x11, 0x0b, 0x68, 0x01, 0x00, 0x00, 0x32, 0x64, 0x7f, 0x00),
  },
  {
    name: "hold end state with profile",
    origin: `${D}; same layout`,
    msg: mk(1, {
      sub: "startSpeedForDegrees",
      degrees: 1,
      speed: -20,
      maxPower: 80,
      endState: 126,
      useProfile: { acc: true, dec: false },
    }),
    bytes: b(0x0e, 0x00, 0x81, 0x01, 0x11, 0x0b, 0x01, 0x00, 0x00, 0x00, 0xec, 0x50, 0x7e, 0x01),
  },
];

const goto: Vector[] = [
  {
    name: "absolute position 0",
    origin: `${D}; node-poweredup absolutemotor.ts:61-62 (Int32 LE)`,
    msg: mk(0, {
      sub: "gotoAbsolutePosition",
      absPos: 0,
      speed: 50,
      maxPower: 100,
      endState: 127,
      useProfile: none,
    }),
    bytes: b(0x0e, 0x00, 0x81, 0x00, 0x11, 0x0d, 0x00, 0x00, 0x00, 0x00, 0x32, 0x64, 0x7f, 0x00),
  },
  {
    name: "negative absolute position is Int32 LE",
    origin: `${D}; node-poweredup absolutemotor.ts:62 (writeInt32LE)`,
    msg: mk(0, {
      sub: "gotoAbsolutePosition",
      absPos: -90,
      speed: 100,
      maxPower: 100,
      endState: 0,
      useProfile: none,
    }),
    bytes: b(0x0e, 0x00, 0x81, 0x00, 0x11, 0x0d, 0xa6, 0xff, 0xff, 0xff, 0x64, 0x64, 0x00, 0x00),
  },
];

const direct: Vector[] = [
  {
    name: "RGB mode 0x01 with R,G,B",
    origin:
      "literal: doc 6.1 (`PortID, SC, 0x51, 0x01, 0x30, 0x47, 0x55`); port 0x32 and SC 0x11 chosen by us",
    msg: mk(0x32, { sub: "writeDirectModeData", mode: 1, data: b(0x30, 0x47, 0x55) }),
    bytes: b(0x0a, 0x00, 0x81, 0x32, 0x11, 0x51, 0x01, 0x30, 0x47, 0x55),
  },
  {
    name: "mode 0x02 with an Int32 (PresetEncoder 100)",
    origin: "derivado del layout: doc 6.1; pybricksdev test_lwp3_messages.py:1407 same bytes",
    msg: mk(1, { sub: "writeDirectModeData", mode: 2, data: b(0x64, 0x00, 0x00, 0x00) }),
    bytes: b(0x0b, 0x00, 0x81, 0x01, 0x11, 0x51, 0x02, 0x64, 0x00, 0x00, 0x00),
  },
  {
    name: "LED color index (mode 0x00 + color)",
    origin: "derivado del layout: doc 6.1 SetRgbColorNo; pylgbst peripherals.py:721",
    msg: mk(0x32, { sub: "writeDirectModeData", mode: 0, data: b(0x03) }),
    bytes: b(0x08, 0x00, 0x81, 0x32, 0x11, 0x51, 0x00, 0x03),
  },
];

const suites: [string, Vector[]][] = [
  ["StartPower 0x01", startPower],
  ["StartPower2 0x02", startPower2],
  ["StartSpeed 0x07", startSpeed],
  ["StartSpeed2 0x08", startSpeed2],
  ["StartSpeedForTime 0x09", forTime],
  ["StartSpeedForDegrees 0x0B", forDegrees],
  ["GotoAbsolutePosition 0x0D", goto],
  ["WriteDirectModeData 0x51", direct],
];

describe("port output command (0x81)", () => {
  for (const [title, vectors] of suites) {
    describe(title, () => {
      it.each(vectors)("encodes and decodes: $name ($origin)", ({ msg, bytes }) => {
        expect(decodePortOutputCommand(payloadOf(bytes))).toEqual({
          type: "portOutputCommand",
          ...msg,
        });
        expect(encodePortOutputCommand(msg)).toEqual(bytes);
      });
    });
  }

  describe("value ranges (encoder throws RangeError)", () => {
    const speedCmd = (speed: number) =>
      mk(0, { sub: "startSpeed", speed, maxPower: 100, useProfile: none });
    const timeCmd = (o: Partial<Extract<PortOutputCommand, { sub: "startSpeedForTime" }>>) =>
      mk(0, {
        sub: "startSpeedForTime",
        time: 1,
        speed: 1,
        maxPower: 1,
        endState: 0,
        useProfile: none,
        ...o,
      });
    const gotoCmd = (o: Partial<Extract<PortOutputCommand, { sub: "gotoAbsolutePosition" }>>) =>
      mk(0, {
        sub: "gotoAbsolutePosition",
        absPos: 0,
        speed: 1,
        maxPower: 1,
        endState: 0,
        useProfile: none,
        ...o,
      });

    it("StartPower: power is -100..100 or 127 (brake); 126 and out-of-range throw", () => {
      const pw = (power: number) => mk(0, { sub: "startPower", power }, stopNow);
      for (const p of [101, -101, 126, 128, 1.5, Number.NaN]) {
        expect(() => encodePortOutputCommand(pw(p))).toThrow(RangeError);
        expect(() =>
          encodePortOutputCommand(mk(0x10, { sub: "startPower2", power1: 0, power2: p }, stopNow)),
        ).toThrow(RangeError);
        expect(() =>
          encodePortOutputCommand(mk(0x10, { sub: "startPower2", power1: p, power2: 0 }, stopNow)),
        ).toThrow(RangeError);
      }
      for (const p of [-100, 0, 100, 127]) {
        expect(encodePortOutputCommand(pw(p))).toHaveLength(7);
      }
    });

    it("StartSpeed: rejects speeds outside -100..100 plus 126 (hold); 127 is StartPower only", () => {
      for (const s of [101, -101, 125, 127, 128, 1.5, Number.NaN]) {
        expect(() => encodePortOutputCommand(speedCmd(s))).toThrow(RangeError);
      }
      for (const s of [-100, 0, 100, 126]) {
        expect(encodePortOutputCommand(speedCmd(s))).toHaveLength(9);
      }
    });

    it("StartSpeedForTime/Degrees: speed is -100..100 only (no 126/127)", () => {
      for (const s of [101, -101, 126, 127]) {
        expect(() => encodePortOutputCommand(timeCmd({ speed: s }))).toThrow(RangeError);
        expect(() =>
          encodePortOutputCommand(
            mk(0, {
              sub: "startSpeedForDegrees",
              degrees: 1,
              speed: s,
              maxPower: 1,
              endState: 0,
              useProfile: none,
            }),
          ),
        ).toThrow(RangeError);
      }
      for (const s of [-100, 0, 100]) {
        expect(encodePortOutputCommand(timeCmd({ speed: s }))).toHaveLength(12);
      }
    });

    it("rejects maxPower outside 0..100", () => {
      expect(() =>
        encodePortOutputCommand(
          mk(0, { sub: "startSpeed", speed: 1, maxPower: 101, useProfile: none }),
        ),
      ).toThrow(RangeError);
      expect(() =>
        encodePortOutputCommand(
          mk(0, { sub: "startSpeed", speed: 1, maxPower: -1, useProfile: none }),
        ),
      ).toThrow(RangeError);
    });

    it("rejects an invalid port, startup, completion and end state", () => {
      expect(() => encodePortOutputCommand(mk(256, speedCmd(1).command))).toThrow(RangeError);
      expect(() => encodePortOutputCommand(mk(-1, speedCmd(1).command))).toThrow(RangeError);
      const cmd = speedCmd(1).command;
      expect(() => encodePortOutputCommand(mk(0, cmd, { startup: "later" as never }))).toThrow(
        RangeError,
      );
      expect(() => encodePortOutputCommand(mk(0, cmd, { completion: "x" as never }))).toThrow(
        RangeError,
      );
      expect(() => encodePortOutputCommand(timeCmd({ endState: 5 as never }))).toThrow(RangeError);
    });

    it("rejects time outside 0..32767 and degrees below 1", () => {
      expect(() => encodePortOutputCommand(timeCmd({ time: 0x8000 }))).toThrow(RangeError);
      expect(() => encodePortOutputCommand(timeCmd({ time: -1 }))).toThrow(RangeError);
      expect(encodePortOutputCommand(timeCmd({ time: 0 }))).toHaveLength(12);
      const deg = (degrees: number) =>
        mk(0, {
          sub: "startSpeedForDegrees",
          degrees,
          speed: 1,
          maxPower: 1,
          endState: 0,
          useProfile: none,
        });
      expect(() => encodePortOutputCommand(deg(0))).toThrow(RangeError);
      expect(() => encodePortOutputCommand(deg(2 ** 31))).toThrow(RangeError);
      expect(encodePortOutputCommand(deg(2 ** 31 - 1))).toHaveLength(14);
    });

    it("goto: speed 1..100 only, absPos is an Int32", () => {
      expect(() => encodePortOutputCommand(gotoCmd({ speed: 0 }))).toThrow(RangeError);
      expect(() => encodePortOutputCommand(gotoCmd({ speed: -5 }))).toThrow(RangeError);
      expect(() => encodePortOutputCommand(gotoCmd({ speed: 127 }))).toThrow(RangeError);
      expect(() => encodePortOutputCommand(gotoCmd({ absPos: 2 ** 31 }))).toThrow(RangeError);
      expect(encodePortOutputCommand(gotoCmd({ absPos: -(2 ** 31) }))).toHaveLength(14);
    });

    it("writeDirectModeData: mode is a u8 and data bytes are u8", () => {
      expect(() =>
        encodePortOutputCommand(mk(0, { sub: "writeDirectModeData", mode: 256, data: b() })),
      ).toThrow(RangeError);
      expect(() =>
        encodePortOutputCommand(
          mk(0, { sub: "writeDirectModeData", mode: 0, data: [256] as unknown as Uint8Array }),
        ),
      ).toThrow(RangeError);
    });
  });

  describe("decode errors and unknown sub-commands", () => {
    it("keeps unmodelled sub-commands as {sub: 'unknown'} with the raw payload", () => {
      // 0x0A (StartSpeedForTime, two speeds) is in doc 3.27 but not modelled here.
      expect(decodePortOutputCommand(b(0x00, 0x11, 0x0a, 0x01, 0x02))).toEqual({
        type: "portOutputCommand",
        port: 0,
        startup: "immediate",
        completion: "feedback",
        command: { sub: "unknown", subCommand: 0x0a, payload: b(0x01, 0x02) },
      });
    });

    it("re-encodes an unknown sub-command", () => {
      expect(
        encodePortOutputCommand(
          mk(0, { sub: "unknown", subCommand: 0x0a, payload: b(0x01, 0x02) }),
        ),
      ).toEqual(b(0x08, 0x00, 0x81, 0x00, 0x11, 0x0a, 0x01, 0x02));
    });

    it("errors payload-too-short when the header or a known sub-command is cut", () => {
      for (const p of [b(), b(0x00), b(0x00, 0x11), b(0x00, 0x11, 0x07, 0x32, 0x64)]) {
        expect(decodePortOutputCommand(p)).toMatchObject({
          kind: "error",
          reason: "payload-too-short",
          messageType: 0x81,
        });
      }
      expect(decodePortOutputCommand(b(0x00, 0x11, 0x0b, 1, 0, 0, 0, 5, 5, 0x7f))).toMatchObject({
        reason: "payload-too-short",
      });
    });

    it("errors bad-field on invalid nibbles, speed, power, end state and profile", () => {
      const bad = (p: Uint8Array, offset: number) =>
        expect(decodePortOutputCommand(p)).toEqual({
          kind: "error",
          reason: "bad-field",
          messageType: 0x81,
          offset,
        });
      bad(b(0x00, 0x21, 0x07, 0x32, 0x64, 0x00), 1); // startup 2
      bad(b(0x00, 0x12, 0x07, 0x32, 0x64, 0x00), 1); // completion 2
      bad(b(0x00, 0x11, 0x07, 0x65, 0x64, 0x00), 3); // speed 101
      bad(b(0x00, 0x11, 0x07, 0x32, 0x65, 0x00), 4); // maxPower 101
      bad(b(0x00, 0x11, 0x07, 0x32, 0x64, 0x04), 5); // profile bit 2
      bad(b(0x00, 0x10, 0x01, 0x65), 3); // power 101
      bad(b(0x00, 0x10, 0x01, 0x7e), 3); // power 126 is not a StartPower value
      bad(b(0x00, 0x10, 0x02, 0x00, 0x80), 4); // power2 -128
      bad(b(0x00, 0x11, 0x09, 0x01, 0x00, 0x32, 0x64, 0x05, 0x00), 7); // endState 5
      bad(b(0x00, 0x11, 0x0d, 0, 0, 0, 0, 0x00, 0x64, 0x00, 0x00), 7); // goto speed 0
    });

    // Decoder leniency: node-poweredup writes time as u16 and degrees as u32 (tachomotor.ts:115,
    // 149), so real apps can send values the strict encoder rejects.
    it("decodes time as u16 and degrees as u32, accepting 0 (lenient)", () => {
      expect(
        decodePortOutputCommand(b(0x00, 0x11, 0x09, 0x00, 0x80, 0x32, 0x64, 0x7f, 0x00)),
      ).toMatchObject({
        command: { sub: "startSpeedForTime", time: 0x8000 },
      });
      expect(
        decodePortOutputCommand(b(0x00, 0x11, 0x09, 0xff, 0xff, 0x32, 0x64, 0x7f, 0x00)),
      ).toMatchObject({
        command: { sub: "startSpeedForTime", time: 0xffff },
      });
      expect(
        decodePortOutputCommand(b(0x00, 0x11, 0x0b, 0, 0, 0, 0, 0x32, 0x64, 0x7f, 0x00)),
      ).toMatchObject({
        command: { sub: "startSpeedForDegrees", degrees: 0 },
      });
      expect(
        decodePortOutputCommand(b(0x00, 0x11, 0x0b, 0, 0, 0, 0x80, 0x32, 0x64, 0x7f, 0x00)),
      ).toMatchObject({
        command: { sub: "startSpeedForDegrees", degrees: 0x80000000 },
      });
    });

    it("decoder stays lenient on speed: 126/127 accepted by every speed field", () => {
      expect(decodePortOutputCommand(b(0x00, 0x11, 0x07, 0x7f, 0x64, 0x00))).toMatchObject({
        command: { sub: "startSpeed", speed: 127 },
      });
      expect(
        decodePortOutputCommand(b(0x00, 0x11, 0x09, 1, 0, 0x7e, 0x64, 0x7f, 0x00)),
      ).toMatchObject({
        command: { sub: "startSpeedForTime", speed: 126 },
      });
      expect(
        decodePortOutputCommand(b(0x00, 0x11, 0x0b, 1, 0, 0, 0, 0x7f, 0x64, 0x7f, 0x00)),
      ).toMatchObject({
        command: { sub: "startSpeedForDegrees", speed: 127 },
      });
    });

    it("ignores trailing bytes after a known sub-command", () => {
      expect(decodePortOutputCommand(b(0x00, 0x11, 0x07, 0x32, 0x64, 0x00, 0xff))).toMatchObject({
        command: { sub: "startSpeed", speed: 50 },
      });
    });
  });
});

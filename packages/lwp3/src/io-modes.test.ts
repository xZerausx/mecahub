import { describe, expect, it } from "vitest";
import { IoTypeId } from "./constants.js";
import { IO_MODES, decodeModeValue, getIoMode, getIoModes } from "./io-modes.js";

const b = (...bytes: number[]) => Uint8Array.of(...bytes);

// Origin of every vector below: 'derivado del layout'. The mode layouts come from the reference
// libraries (each IoModeInfo cites file:line); no real capture of a 0x45 value exists yet, so
// everything is TODO(hw) (docs/protocol-notes.md). Little-endian per ADR 0002.
describe("io-type mode table (shape)", () => {
  const types = [
    IoTypeId.ExternalMotorWithTacho,
    IoTypeId.InternalMotorWithTacho,
    IoTypeId.RgbLight,
    IoTypeId.InternalTilt,
    IoTypeId.ColorDistanceSensor,
    IoTypeId.Current,
    IoTypeId.Voltage,
  ];

  it("covers the Move Hub io types", () => {
    for (const t of types) expect(getIoModes(t).length).toBeGreaterThan(0);
  });

  it("returns an empty list for an io type it does not know", () => {
    expect(getIoModes(0x42)).toEqual([]);
    expect(getIoMode(0x42, 0)).toBeUndefined();
  });

  it.each(types)("io type 0x%s: every entry is well formed and cites a reference", (t) => {
    const seen = new Set<number>();
    for (const m of getIoModes(t)) {
      expect(seen.has(m.mode), `duplicate mode ${m.mode}`).toBe(false);
      seen.add(m.mode);
      expect(Number.isInteger(m.mode) && m.mode >= 0 && m.mode <= 0xff).toBe(true);
      expect(m.name).not.toBe("");
      expect(m.count).toBeGreaterThanOrEqual(1);
      expect([1, 2, 4]).toContain(m.width);
      expect(typeof m.signed).toBe("boolean");
      expect(m.unit).not.toBe("");
      expect(["input", "output"]).toContain(m.access);
      expect(m.refs.length).toBeGreaterThanOrEqual(1);
      for (const r of m.refs) expect(r).toMatch(/^(pylgbst|node-poweredup)\/\S+\.(py|ts):\d+/);
    }
  });

  it("tacho motors share one table: speed (mode 1, i8) and position (mode 2, i32)", () => {
    for (const t of [IoTypeId.ExternalMotorWithTacho, IoTypeId.InternalMotorWithTacho]) {
      expect(getIoMode(t, 1)).toMatchObject({ name: "speed", count: 1, width: 1, signed: true });
      expect(getIoMode(t, 2)).toMatchObject({ name: "position", count: 1, width: 4, signed: true });
    }
  });

  it("does not invent the unconfirmed motor power mode", () => {
    expect(getIoMode(IoTypeId.InternalMotorWithTacho, 0)).toBeUndefined();
  });

  it("lists the modes known by two libraries and flags the single-library ones", () => {
    const libraries = (t: number, m: number) =>
      new Set(getIoMode(t, m)?.refs.map((r) => r.split("/")[0])).size;
    expect(libraries(IoTypeId.ColorDistanceSensor, 0)).toBe(2);
    expect(libraries(IoTypeId.InternalTilt, 0)).toBe(2);
    expect(libraries(IoTypeId.InternalMotorWithTacho, 2)).toBe(2);
    expect(libraries(IoTypeId.InternalMotorWithTacho, 1)).toBe(1);
    expect(libraries(IoTypeId.InternalTilt, 3)).toBe(1);
  });

  it("records the voltage scale conflict between the references", () => {
    expect(getIoMode(IoTypeId.Voltage, 0)?.note).toMatch(/conflict/i);
  });

  it("is keyed by io type id", () => {
    expect(Object.keys(IO_MODES).map(Number)).toEqual(expect.arrayContaining(types));
  });
});

describe("decodeModeValue", () => {
  it.each([
    ["motor speed -50", IoTypeId.InternalMotorWithTacho, 1, b(0xce), [-50]],
    ["motor position 1000", IoTypeId.InternalMotorWithTacho, 2, b(0xe8, 0x03, 0, 0), [1000]],
    [
      "motor position -1000",
      IoTypeId.ExternalMotorWithTacho,
      2,
      b(0x18, 0xfc, 0xff, 0xff),
      [-1000],
    ],
    ["tilt (roll -3, pitch 5)", IoTypeId.InternalTilt, 0, b(0xfd, 0x05), [-3, 5]],
    ["tilt impact count", IoTypeId.InternalTilt, 3, b(0x02, 0x01, 0, 0), [258]],
    ["tilt accel 3 axes", IoTypeId.InternalTilt, 4, b(0x01, 0xff, 0x7f), [1, -1, 127]],
    ["color index 9", IoTypeId.ColorDistanceSensor, 0, b(0x09), [9]],
    ["detection count", IoTypeId.ColorDistanceSensor, 2, b(0x05, 0, 0, 0), [5]],
    [
      "rgb 3 x u16",
      IoTypeId.ColorDistanceSensor,
      6,
      b(0x34, 0x12, 0xff, 0x03, 0, 0),
      [0x1234, 1023, 0],
    ],
    ["color+distance", IoTypeId.ColorDistanceSensor, 8, b(0x03, 0x04, 0x00, 0x02), [3, 4, 0, 2]],
    ["current raw", IoTypeId.Current, 0, b(0xff, 0x0f), [4095]],
    ["voltage raw", IoTypeId.Voltage, 0, b(0x35, 0x0f), [3893]],
    ["led rgb", IoTypeId.RgbLight, 1, b(1, 2, 3), [1, 2, 3]],
  ] as const)("%s", (_name, ioType, mode, raw, expected) => {
    expect(decodeModeValue(ioType, mode, raw)).toEqual(expected);
  });

  it("returns undefined for an unknown io type or mode", () => {
    expect(decodeModeValue(0x42, 0, b(1))).toBeUndefined();
    expect(decodeModeValue(IoTypeId.InternalMotorWithTacho, 9, b(1))).toBeUndefined();
  });

  it("returns undefined when the length does not match the mode (a value of the previous mode)", () => {
    expect(decodeModeValue(IoTypeId.InternalMotorWithTacho, 2, b(1))).toBeUndefined();
    expect(decodeModeValue(IoTypeId.InternalMotorWithTacho, 1, b(1, 2))).toBeUndefined();
    expect(decodeModeValue(IoTypeId.ColorDistanceSensor, 6, b(1, 2, 3, 4))).toBeUndefined();
  });
});

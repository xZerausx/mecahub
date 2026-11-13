import { describe, expect, it } from "vitest";
import { parseCapture } from "./fixtures.js";

describe("parseCapture", () => {
  it("parses rx and tx lines into at/dir/bytes", () => {
    const text = ["+0ms tx 05 00 01 06 02", "+120ms rx 06 00 01 06 06 55"].join("\n");
    expect(parseCapture(text)).toEqual([
      { at: 0, dir: "tx", bytes: Uint8Array.of(0x05, 0x00, 0x01, 0x06, 0x02) },
      { at: 120, dir: "rx", bytes: Uint8Array.of(0x06, 0x00, 0x01, 0x06, 0x06, 0x55) },
    ]);
  });

  it("skips comment and blank lines, tolerates CRLF", () => {
    const text = "# header\r\n\r\n+5ms rx 05 00 04 01 00\r\n# note\r\n";
    expect(parseCapture(text)).toEqual([
      { at: 5, dir: "rx", bytes: Uint8Array.of(0x05, 0x00, 0x04, 0x01, 0x00) },
    ]);
  });

  it("accepts lowercase hex", () => {
    expect(parseCapture("+1ms rx 0f 0a")[0]?.bytes).toEqual(Uint8Array.of(0x0f, 0x0a));
  });

  it.each([
    ["bad direction", "+1ms up 05"],
    ["missing time", "rx 05 00"],
    ["bad hex", "+1ms rx 0G"],
    ["single-digit hex", "+1ms rx 5 00"],
    ["no bytes", "+1ms rx"],
  ])("throws on a malformed line (%s)", (_name, line) => {
    expect(() => parseCapture(line)).toThrow(/line 1/);
  });
});

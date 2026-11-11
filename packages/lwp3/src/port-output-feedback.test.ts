import { describe, expect, it } from "vitest";
import { decodeHeader } from "./header.js";
import { decodePortOutputFeedback, encodePortOutputFeedback } from "./port-output-feedback.js";

const b = (...bytes: number[]) => Uint8Array.of(...bytes);

function payloadOf(frame: Uint8Array): Uint8Array {
  const h = decodeHeader(frame);
  if ("kind" in h) throw new Error("bad frame");
  return h.payload;
}

const flags = (
  port: number,
  raw: number,
  f: Partial<Record<"inProgress" | "completed" | "discarded" | "idle" | "busy", true>> = {},
) => ({
  port,
  flags: raw,
  bufferEmptyInProgress: f.inProgress === true,
  bufferEmptyCompleted: f.completed === true,
  discarded: f.discarded === true,
  idle: f.idle === true,
  busyFull: f.busy === true,
});

// Layout (doc 3.32): [len = 3 + 2n, 0, 0x82, (port, flags) x n]; bits 0x01 buffer empty + in
// progress, 0x02 buffer empty + completed, 0x04 discarded, 0x08 idle, 0x10 busy/full.
// pybricksdev messages.py:1508-1527 (length 5, +2 per extra port; Feedback bits at
// bytecodes.py:1063-1068), node-poweredup lpf2hub.ts:350-358 (loop over pairs from offset 3) and
// pylgbst messages.py:801-808 (bits 0x01, 0x02, 0x04) agree.
const vectors = [
  {
    name: "one port, completed + idle (0x0A, the Move Hub value, TODO(hw))",
    origin: "derivado del layout: doc 3.32",
    bytes: b(0x05, 0x00, 0x82, 0x00, 0x0a),
    ports: [flags(0, 0x0a, { completed: true, idle: true })],
  },
  {
    name: "two ports (pybricksdev test_lwp3_messages.py:1436-1443 uses ports 1, 2)",
    origin: "derivado del layout: doc 3.32",
    bytes: b(0x07, 0x00, 0x82, 0x00, 0x0a, 0x01, 0x02),
    ports: [flags(0, 0x0a, { completed: true, idle: true }), flags(1, 0x02, { completed: true })],
  },
  {
    name: "three ports, each flag",
    origin: "derivado del layout: doc 3.32; pybricksdev test_lwp3_messages.py:1456-1472",
    bytes: b(0x09, 0x00, 0x82, 0x01, 0x01, 0x02, 0x04, 0x03, 0x10),
    ports: [
      flags(1, 0x01, { inProgress: true }),
      flags(2, 0x04, { discarded: true }),
      flags(3, 0x10, { busy: true }),
    ],
  },
  {
    name: "no flags set",
    origin: "derivado del layout: doc 3.32",
    bytes: b(0x05, 0x00, 0x82, 0x10, 0x00),
    ports: [flags(0x10, 0x00)],
  },
];

describe("port output command feedback (0x82)", () => {
  it.each(vectors)("encodes and decodes: $name ($origin)", ({ bytes, ports }) => {
    expect(encodePortOutputFeedback({ ports })).toEqual(bytes);
    expect(decodePortOutputFeedback(payloadOf(bytes))).toEqual({
      type: "portOutputFeedback",
      ports,
    });
  });

  it("errors payload-too-short on an empty payload and bad-field on a dangling port id", () => {
    expect(decodePortOutputFeedback(b())).toMatchObject({
      kind: "error",
      reason: "payload-too-short",
      messageType: 0x82,
    });
    expect(decodePortOutputFeedback(b(0x00))).toMatchObject({
      kind: "error",
      reason: "payload-too-short",
      messageType: 0x82,
      offset: 1,
    });
    expect(decodePortOutputFeedback(b(0x00, 0x0a, 0x01))).toEqual({
      kind: "error",
      reason: "bad-field",
      messageType: 0x82,
      offset: 2,
    });
  });

  it("keeps the raw flags byte, including bits the doc does not define", () => {
    expect(decodePortOutputFeedback(b(0x00, 0xe1))).toEqual({
      type: "portOutputFeedback",
      ports: [flags(0, 0xe1, { inProgress: true })],
    });
  });

  it("encoder throws RangeError on no ports or out-of-range bytes", () => {
    expect(() => encodePortOutputFeedback({ ports: [] })).toThrow(RangeError);
    expect(() => encodePortOutputFeedback({ ports: [{ port: 256, flags: 0 }] })).toThrow(
      RangeError,
    );
    expect(() => encodePortOutputFeedback({ ports: [{ port: 0, flags: -1 }] })).toThrow(RangeError);
  });
});

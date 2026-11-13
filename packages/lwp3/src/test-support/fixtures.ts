// Test support only (published as @mecahub/lwp3/testing, never from the package index). Node `fs`
// is used here (and only here) to read real-hub captures from packages/lwp3/fixtures/
// (format: fixtures/README.md).
import { readFileSync } from "node:fs";

export interface CaptureFrame {
  /** Milliseconds since connecting. */
  readonly at: number;
  /** `tx` = sent to the hub, `rx` = received from it. */
  readonly dir: "tx" | "rx";
  readonly bytes: Uint8Array;
}

const LINE = /^\+(\d+)ms (rx|tx) ((?:[0-9A-Fa-f]{2})(?: [0-9A-Fa-f]{2})*)$/;

/** Parses the text of a capture: `+<n>ms <rx|tx> <HEX bytes>` lines; `#` and blank lines skipped. */
export function parseCapture(text: string): CaptureFrame[] {
  const frames: CaptureFrame[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = LINE.exec(line);
    if (!m) throw new Error(`malformed capture line ${i + 1}: ${JSON.stringify(raw)}`);
    frames.push({
      at: Number(m[1]),
      dir: m[2] as "rx" | "tx",
      bytes: Uint8Array.from(m[3]!.split(" "), (h) => parseInt(h, 16)),
    });
  });
  return frames;
}

/** Loads `packages/lwp3/fixtures/<name>`. */
export function loadCapture(name: string): CaptureFrame[] {
  return parseCapture(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), "utf8"));
}

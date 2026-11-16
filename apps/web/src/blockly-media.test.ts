import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// public/blockly-media is Blockly's own material, redistributed under Apache-2.0: the license
// terms (attribution, source, version) must travel with it and be in NOTICE.
const read = (url: string) => readFileSync(new URL(url, import.meta.url), "utf8");

describe("Blockly media attribution", () => {
  it("has a README next to the files naming the license, owner, source and version", () => {
    const readme = read("../public/blockly-media/README.md");
    expect(readme).toMatch(/Apache License,? (Version )?2\.0|Apache-2\.0/);
    expect(readme).toMatch(/Copyright .*Google LLC/);
    expect(readme).toContain("https://github.com/google/blockly");
    expect(readme).toContain("13.4.0");
  });

  it("is listed in NOTICE", () => {
    const notice = read("../../../NOTICE");
    expect(notice).toMatch(/Blockly/);
    expect(notice).toMatch(/Google LLC/);
    expect(notice).toMatch(/Apache-2\.0/);
  });

  it("matches the pinned blockly version", () => {
    const pinned = (JSON.parse(read("../package.json")) as { dependencies: Record<string, string> })
      .dependencies.blockly;
    expect(read("../public/blockly-media/README.md")).toContain(pinned ?? "missing");
  });
});

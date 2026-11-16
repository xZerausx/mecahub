import { describe, expect, it } from "vitest";
import { PortArbiter } from "./arbiter.js";

describe("PortArbiter", () => {
  it("a claim on a free port is not replaced", () => {
    const arbiter = new PortArbiter();
    expect(arbiter.claim(["A"]).signal.aborted).toBe(false);
  });

  it("an overlapping claim aborts the earlier one", () => {
    const arbiter = new PortArbiter();
    const first = arbiter.claim(["A"]);
    const second = arbiter.claim(["A"]);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it("disjoint claims coexist", () => {
    const arbiter = new PortArbiter();
    const a = arbiter.claim(["A"]);
    const c = arbiter.claim(["C"]);
    expect(a.signal.aborted || c.signal.aborted).toBe(false);
  });

  it("AB overlaps both A and B, and A or B overlap AB", () => {
    const arbiter = new PortArbiter();
    const a = arbiter.claim(["A"]);
    const b = arbiter.claim(["B"]);
    const ab = arbiter.claim(["A", "B"]);
    expect(a.signal.aborted && b.signal.aborted).toBe(true);
    expect(ab.signal.aborted).toBe(false);
    arbiter.claim(["B"]);
    expect(ab.signal.aborted).toBe(true);
  });

  it("a released claim is not replaced later", () => {
    const arbiter = new PortArbiter();
    const first = arbiter.claim(["A"]);
    first.release();
    arbiter.claim(["A"]);
    expect(first.signal.aborted).toBe(false);
  });

  it("releasing a replaced claim is harmless and does not free the newer one", () => {
    const arbiter = new PortArbiter();
    const first = arbiter.claim(["A"]);
    const second = arbiter.claim(["A"]);
    first.release();
    arbiter.claim(["A"]);
    expect(second.signal.aborted).toBe(true);
  });
});

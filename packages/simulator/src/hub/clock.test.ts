import { describe, expect, it, vi } from "vitest";
import { ManualClock, realClock } from "./clock.js";

describe("ManualClock", () => {
  it("starts at 0 and only moves through advance", () => {
    const clock = new ManualClock();
    expect(clock.now()).toBe(0);
    clock.advance(25);
    expect(clock.now()).toBe(25);
  });

  it("runs a timer once its delay elapsed, not before", () => {
    const clock = new ManualClock();
    const fn = vi.fn();
    clock.setTimeout(fn, 10);
    clock.advance(9);
    expect(fn).not.toHaveBeenCalled();
    clock.advance(1);
    expect(fn).toHaveBeenCalledTimes(1);
    clock.advance(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs due timers in (due time, creation) order and sees the right now() in each", () => {
    const clock = new ManualClock();
    const log: string[] = [];
    clock.setTimeout(() => log.push(`b@${clock.now()}`), 20);
    clock.setTimeout(() => log.push(`a@${clock.now()}`), 10);
    clock.setTimeout(() => log.push(`c@${clock.now()}`), 20);
    clock.advance(50);
    expect(log).toEqual(["a@10", "b@20", "c@20"]);
    expect(clock.now()).toBe(50);
  });

  it("runs timers scheduled by a timer when they fall inside the advance window", () => {
    const clock = new ManualClock();
    const log: number[] = [];
    clock.setTimeout(() => {
      log.push(clock.now());
      clock.setTimeout(() => log.push(clock.now()), 5);
    }, 10);
    clock.advance(20);
    expect(log).toEqual([10, 15]);
  });

  it("clearTimeout cancels a pending timer; pending counts the live ones", () => {
    const clock = new ManualClock();
    const fn = vi.fn();
    const h = clock.setTimeout(fn, 10);
    clock.setTimeout(() => undefined, 10);
    expect(clock.pending).toBe(2);
    clock.clearTimeout(h);
    expect(clock.pending).toBe(1);
    clock.advance(10);
    expect(fn).not.toHaveBeenCalled();
    expect(clock.pending).toBe(0);
  });

  it("a delay of 0 runs on the next advance(0)", () => {
    const clock = new ManualClock();
    const fn = vi.fn();
    clock.setTimeout(fn, 0);
    expect(fn).not.toHaveBeenCalled();
    clock.advance(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("ManualClock.advance robustness", () => {
  it("throws RangeError on a negative or non-finite delay and leaves time untouched", () => {
    const clock = new ManualClock();
    clock.advance(5);
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => clock.advance(ms)).toThrow(RangeError);
    }
    expect(clock.now()).toBe(5);
  });

  it("a throwing callback does not stop later timers or leave time behind; the first error is rethrown", () => {
    const clock = new ManualClock();
    const later = vi.fn();
    clock.setTimeout(() => {
      throw new Error("first");
    }, 5);
    clock.setTimeout(() => {
      throw new Error("second");
    }, 6);
    clock.setTimeout(later, 7);
    expect(() => clock.advance(10)).toThrow("first");
    expect(later).toHaveBeenCalledTimes(1);
    expect(clock.now()).toBe(10);
    expect(clock.pending).toBe(0);
  });
});

describe("realClock", () => {
  it("now() follows the wall clock and timers fire (and can be cleared)", async () => {
    const before = realClock.now();
    const fn = vi.fn();
    const cleared = vi.fn();
    realClock.clearTimeout(realClock.setTimeout(cleared, 5));
    realClock.setTimeout(fn, 5);
    await new Promise((r) => setTimeout(r, 30));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(cleared).not.toHaveBeenCalled();
    expect(realClock.now()).toBeGreaterThan(before);
  });
});

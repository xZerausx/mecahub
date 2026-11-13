import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_DEG_PER_SEC, SimMotor } from "./motor.js";

describe("SimMotor", () => {
  it("starts still at position 0", () => {
    const m = new SimMotor(1000);
    expect([m.position, m.speed, m.moving]).toEqual([0, 0, false]);
  });

  it("moves speed% of maxDegPerSec: 50% of 1000 deg/s is 50 degrees in 100 ms", () => {
    const m = new SimMotor(1000);
    m.run(50);
    m.step(100);
    expect(m.position).toBeCloseTo(50);
    expect(m.moving).toBe(true);
  });

  it("negative speed turns the other way, and the speed is clamped to -100..100", () => {
    const m = new SimMotor(1000);
    m.run(-250);
    expect(m.speed).toBe(-100);
    m.step(10);
    expect(m.position).toBeCloseTo(-10);
  });

  it("stop makes it still and forgets the target", () => {
    const m = new SimMotor(1000);
    m.moveTo(500, 100);
    m.stop();
    m.step(100);
    expect([m.position, m.speed, m.moving]).toEqual([0, 0, false]);
  });

  it("moveTo stops exactly at the target, never past it, whatever the step size", () => {
    const m = new SimMotor(1000);
    m.moveTo(25, 100);
    expect(m.speed).toBe(100);
    m.step(100); // would travel 100 degrees
    expect([m.position, m.speed, m.seeking]).toEqual([25, 0, false]);
    m.moveTo(-5, 40); // back down, sign comes from the target
    expect(m.speed).toBe(-40);
    m.step(1000);
    expect([m.position, m.speed]).toEqual([-5, 0]);
  });

  it("moveTo clamps the speed to 1..100 percent (the doc range): 127 runs at 100", () => {
    const m = new SimMotor(1000);
    m.moveTo(500, 127);
    expect(m.speed).toBe(100);
  });

  it("moveTo the current position does not move and is not seeking", () => {
    const m = new SimMotor(1000);
    m.moveTo(0, 50);
    expect([m.speed, m.seeking]).toEqual([0, false]);
  });

  it("reports an integer position (rounded)", () => {
    const m = new SimMotor(1000);
    m.run(1);
    m.step(149); // 1.49 degrees
    expect(m.degrees).toBe(1);
    m.step(2); // 1.51
    expect(m.degrees).toBe(2);
  });

  it("the default maximum speed is a labelled assumption of 1000 deg/s", () => {
    expect(DEFAULT_MAX_DEG_PER_SEC).toBe(1000);
  });
});

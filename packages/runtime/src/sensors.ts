import type { MotorPort, Program, SensedColor, SensorPort } from "@mecahub/ir";
import type { Resource } from "./device.js";
import type { SensorReadings } from "./expressions.js";

/** Which sensors a program reads, found by scanning it once before it starts. */
export interface SensorPlan {
  readonly colorDistance: ReadonlySet<SensorPort>;
  readonly positions: ReadonlySet<MotorPort>;
  readonly tilt: boolean;
  readonly button: boolean;
  /** Everything the program needs from the robot, motors and LED included. */
  readonly resources: readonly Resource[];
}

/** Walks the whole program (statements, expressions, triggers) collecting what it needs. */
export function planProgram(program: Program): SensorPlan {
  const colorDistance = new Set<SensorPort>();
  const positions = new Set<MotorPort>();
  const resources = new Set<Resource>();
  let tilt = false;
  let button = false;

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const n = node as Record<string, unknown>;
    switch (n["type"]) {
      case "motorStart":
      case "motorStop":
      case "motorRunForTime":
      case "motorRunForDegrees":
        resources.add(`motor:${n["port"] as MotorPort}`);
        break;
      case "driveStart":
      case "driveStop":
        resources.add("drive");
        break;
      case "driveForTime":
      case "driveForDegrees":
        resources.add("motor:A").add("motor:B");
        break;
      case "setLed":
        resources.add("led");
        break;
      case "colorSeen":
      case "distanceBelow":
      case "colorIs":
        colorDistance.add(n["port"] as SensorPort);
        break;
      case "tilt":
        tilt = true;
        break;
      case "buttonPressed":
        button = true;
        break;
      case "sensor":
        switch (n["sensor"]) {
          case "color":
          case "distance":
            colorDistance.add(n["port"] as SensorPort);
            break;
          case "motorPosition":
            positions.add(n["port"] as MotorPort);
            resources.add(`motor:${n["port"] as MotorPort}`);
            break;
          case "tiltX":
          case "tiltY":
            tilt = true;
            break;
          case "button":
            button = true;
            break;
        }
        break;
    }
    for (const child of Object.values(n)) visit(child);
  };
  visit(program.scripts);

  for (const port of colorDistance) resources.add(`colorDistance:${port}`);
  if (tilt) resources.add("tilt");
  if (button) resources.add("button");
  return { colorDistance, positions, tilt, button, resources: [...resources] };
}

interface Position {
  base: number;
  current: number;
}

/** The latest value of every sensor the run subscribed to, read synchronously by expressions. */
export class SensorCache implements SensorReadings {
  private readonly colors = new Map<SensorPort, { color: SensedColor; distance: number }>();
  private readonly positions = new Map<MotorPort, Position>();
  private tiltValue: { x: number; y: number } | undefined;
  private buttonValue = false;

  setColorDistance(port: SensorPort, color: SensedColor, distance: number): void {
    this.colors.set(port, { color, distance });
  }
  setTilt(x: number, y: number): void {
    this.tiltValue = { x, y };
  }
  setButton(pressed: boolean): void {
    this.buttonValue = pressed;
  }
  /** The first value of a run becomes position 0 (supuesto: not the connect-time zero, TODO(hw)). */
  setPosition(port: MotorPort, degrees: number): void {
    const known = this.positions.get(port);
    if (known) known.current = degrees;
    else this.positions.set(port, { base: degrees, current: degrees });
  }

  /** Has every sensor of the plan reported? (The button is read as released until it says otherwise.) */
  ready(plan: SensorPlan): boolean {
    return (
      [...plan.colorDistance].every((p) => this.colors.has(p)) &&
      [...plan.positions].every((p) => this.positions.has(p)) &&
      (!plan.tilt || this.tiltValue !== undefined)
    );
  }

  color = (port: SensorPort): SensedColor => this.colors.get(port)?.color ?? "none";
  distance = (port: SensorPort): number => this.colors.get(port)?.distance ?? 0;
  tilt = (): { x: number; y: number } => this.tiltValue ?? { x: 0, y: 0 };
  button = (): boolean => this.buttonValue;
  motorPosition = (port: MotorPort): number => {
    const p = this.positions.get(port);
    return p ? p.current - p.base : 0;
  };
}

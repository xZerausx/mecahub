import { SimulatedHub, SimulatorTransport, defaultMoveHubConfig } from "@mecahub/simulator";
import type { SimClock, SimHubConfig } from "@mecahub/simulator";
import { vi } from "vitest";
import { MoveHub } from "../move-hub.js";

const v = { major: 1, minor: 0, bugfix: 0, build: 0 };

/** The captured Move Hub plus an external tacho motor (0x26) on C, which the capture did not have. */
export function configWithMotorOnC(): SimHubConfig {
  const base = defaultMoveHubConfig();
  const ports = [
    ...base.ports.slice(0, 2),
    { port: 0x02, ioType: 0x26, hw: v, sw: v },
    ...base.ports.slice(2),
  ];
  return { ...base, ports };
}

/**
 * A MoveHub over a SimulatedHub, connected. Uses vitest fake timers (the hub's own timers and the
 * write queue's deadlines are real `setTimeout`s): the caller restores real timers afterwards.
 */
export async function startSim(
  options: { config?: SimHubConfig; latency?: number; clock?: SimClock } = {},
) {
  vi.useFakeTimers();
  const hub = new SimulatedHub(
    options.config ?? defaultMoveHubConfig(),
    options.clock ? { clock: options.clock } : {},
  );
  const sim = new SimulatorTransport(
    hub,
    options.latency === undefined ? {} : { writeLatencyMs: options.latency },
  );
  const moveHub = new MoveHub(sim);
  const connecting = moveHub.connect();
  await vi.advanceTimersByTimeAsync(300);
  await connecting;
  return {
    hub,
    sim,
    moveHub,
    close() {
      moveHub.dispose();
      sim.dispose();
      hub.dispose();
    },
  };
}

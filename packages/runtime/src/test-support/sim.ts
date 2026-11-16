import { MoveHub } from "@mecahub/hub";
import { SimulatedHub, SimulatorTransport, defaultMoveHubConfig } from "@mecahub/simulator";
import type { SimHubConfig } from "@mecahub/simulator";
import { vi } from "vitest";

/**
 * A MoveHub over a SimulatedHub, connected. Same shape as the hub package's own test helper (a
 * minimal copy: it is not exported there). Uses vitest fake timers (unless `realTimers`), because the hub layer's timers
 * are real `setTimeout`s: the caller restores real timers afterwards.
 */
export async function startSim(
  options: { config?: SimHubConfig; latency?: number; realTimers?: boolean } = {},
) {
  if (!options.realTimers) vi.useFakeTimers();
  const hub = new SimulatedHub(options.config ?? defaultMoveHubConfig());
  const sim = new SimulatorTransport(
    hub,
    options.latency === undefined ? {} : { writeLatencyMs: options.latency },
  );
  const moveHub = new MoveHub(sim);
  const connecting = moveHub.connect();
  if (!options.realTimers) await vi.advanceTimersByTimeAsync(300);
  await connecting;
  sim.sentFrames.splice(0); // what connect() wrote
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

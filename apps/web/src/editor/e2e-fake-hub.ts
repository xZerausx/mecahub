import type { BleTransport } from "@mecahub/transport";
import { SimulatedHub, SimulatorTransport, defaultMoveHubConfig } from "@mecahub/simulator";

// FOR BROWSER TESTS ONLY. main.tsx loads this module through a dynamic import behind
// `import.meta.env.VITE_E2E_FAKE_HUB === "1"`, a build-time constant: a production build replaces it
// by `false` and never emits this file (the e2e suite greps the bundle to prove it).

export interface FakeHubControls {
  /** The hub's link ends without the app asking for it. */
  drop(): void;
}

/** A "real hub" for Playwright: the simulator behind a BleTransport, with the write latency of a link. */
export function createFakeHubTransport(): BleTransport {
  const hub = new SimulatedHub(defaultMoveHubConfig());
  const transport = new SimulatorTransport(hub, { writeLatencyMs: 20 });
  const controls: FakeHubControls = { drop: () => transport.dropLink() };
  (globalThis as { __fakeHub?: FakeHubControls }).__fakeHub = controls;
  return transport;
}

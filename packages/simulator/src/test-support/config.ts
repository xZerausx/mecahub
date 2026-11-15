import { defaultMoveHubConfig, type SimHubConfig } from "../hub/config.js";

/**
 * The default Move Hub with every motor at a round 1000 deg/s at 100 %, so kinematics tests can do
 * their arithmetic by head (50 % for 100 ms is 50 degrees). Not a measurement: the captured
 * default (`DEFAULT_MAX_DEG_PER_SEC`) is pinned in motor.test.ts.
 */
export function roundRateConfig(): SimHubConfig {
  const base = defaultMoveHubConfig();
  return {
    ...base,
    ports: base.ports.map((p) => (p.ioType === 0x27 ? { ...p, maxDegPerSec: 1000 } : p)),
  };
}

// Test support only: imports vitest, so never import it from production code. It lets every
// BleTransport implementation (fake, web, simulator, native) run the same contract suite.
export { describeTransportContract } from "./contract.js";
export type { ContractHarness } from "./contract.js";

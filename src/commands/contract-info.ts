/**
 * Read-only provider handshake for Core and other execution hosts.
 *
 * This command intentionally does not resolve a project, read .zigma-flow,
 * initialize a database, create a run, or allocate a workspace. It reports
 * only the provider-owned machine contract surface.
 */

import { getPackageInfo } from "../utils/index.js";

export const FLOW_CONTRACT_VERSION = 1 as const;

/** Stable capability names advertised by the Flow v1 provider boundary. */
export const FLOW_CONTRACT_CAPABILITIES = [
  "caller-context-v1",
  "invoke-json-v1",
  "context-freeze-v1",
] as const;

export interface FlowContractInfoV1 {
  contractVersion: typeof FLOW_CONTRACT_VERSION;
  provider: "zigma-flow";
  packageVersion: string;
  capabilities: readonly string[];
}

export function getFlowContractInfo(): FlowContractInfoV1 {
  return {
    contractVersion: FLOW_CONTRACT_VERSION,
    provider: "zigma-flow",
    packageVersion: getPackageInfo().version,
    capabilities: [...FLOW_CONTRACT_CAPABILITIES],
  };
}

/** Render exactly one JSON document on stdout. */
export function contractInfoAction(): void {
  console.log(JSON.stringify(getFlowContractInfo()));
}

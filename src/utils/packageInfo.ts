export interface PackageInfo {
  name: "zigma-flow";
  version: string;
}

export function getPackageInfo(): PackageInfo {
  return {
    name: "zigma-flow",
    version: process.env.ZIGMA_FLOW_VERSION ?? "0.0.0",
  };
}

export interface PackageInfo {
  name: "zigma-flow";
  version: string;
}

export function getPackageInfo(): PackageInfo {
  return {
    name: "zigma-flow",
    version: "0.1.0"
  };
}

const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { resolve } = require("metro-resolver");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.unstable_enablePackageExports = true;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return resolve(context, moduleName.slice(0, -3) + ".ts", platform);
    } catch {
      // Not a TypeScript source import.
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;

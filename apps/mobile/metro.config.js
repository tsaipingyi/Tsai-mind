// Metro config that understands the pnpm workspace: watch the repo root so
// `@tsai-mind/core` (a workspace package) is bundled, and resolve modules from
// both this app's node_modules and the root ones.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules'), path.resolve(workspaceRoot, 'node_modules')];
// pnpm keeps real packages under node_modules/.pnpm and links them; Metro must follow symlinks
config.resolver.unstable_enableSymlinks = true;
config.resolver.disableHierarchicalLookup = false;

module.exports = config;

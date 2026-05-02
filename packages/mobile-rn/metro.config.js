// Metro config — tuned for the npm-workspace layout.
//
// The standard RN template assumes `node_modules` lives next to the
// app. In a workspace, packages share a hoisted root `node_modules/`,
// and Metro needs to be told to:
//   1. watch the workspace root (so changes to @meo/shared trigger
//      a rebuild)
//   2. resolve modules from BOTH this package and the root
//   3. stub out the AI deps that @meo/shared/ai pulls in but we
//      don't ship in v1 (onnxruntime-web, @huggingface/transformers,
//      llama.rn — see README "Phase 2")

const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const stubPath = path.resolve(projectRoot, 'src/empty-stub.js');

const STUBBED_MODULES = new Set([
  'onnxruntime-web',
  'onnxruntime-react-native',
  '@huggingface/transformers',
  'llama.rn',
]);

const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
    extraNodeModules: {
      react: path.resolve(projectRoot, 'node_modules', 'react'),
      'react-native': path.resolve(projectRoot, 'node_modules', 'react-native'),
    },
    disableHierarchicalLookup: false,
    resolveRequest: (context, moduleName, platform) => {
      // Strip known AI deps so Metro doesn't try to parse their
      // ESM bundles (which use dynamic import() and break the RN
      // transformer).
      if (STUBBED_MODULES.has(moduleName)) {
        return { type: 'sourceFile', filePath: stubPath };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);

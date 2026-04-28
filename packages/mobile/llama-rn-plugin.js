// Local Expo config plugin for llama.rn.
//
// llama.rn 0.11.5 ships an `app.plugin.js` that mis-imports
// `@expo/config-plugins` (uses default-import on a CJS module that
// only exposes named exports), which breaks under Expo SDK 51's
// plugin loader. We work around this with a tiny local plugin that
// applies the same set of transforms we actually need:
//
//   - iOS: bump C++ standard to gnu++20 and inject a "$(inherited)
//     -std=gnu++20" flag, which llama.cpp requires.
//   - iOS: in EAS production builds, request the extended virtual
//     addressing entitlement so the model can mmap > 2 GB. Local dev
//     builds skip this so they don't need a paid Apple account.
//
// We deliberately do NOT enable OpenCL / Hexagon (Android-only ML
// backends). Defaults from llama.rn's stock plugin.

const { withXcodeProject } = require('@expo/config-plugins');

function withLlamaRnLocal(config) {
  return withXcodeProject(config, (c) => {
    const project = c.modResults;
    const configs = project.pbxXCBuildConfigurationSection();
    Object.values(configs).forEach((cfg) => {
      if (typeof cfg !== 'object' || !cfg.buildSettings) return;
      cfg.buildSettings['CLANG_CXX_LANGUAGE_STANDARD'] = '"gnu++20"';
      cfg.buildSettings['CLANG_CXX_LIBRARY'] = '"libc++"';
      const current = String(cfg.buildSettings['OTHER_CPLUSPLUSFLAGS'] || '$(inherited)');
      if (!current.includes('-std=gnu++20')) {
        cfg.buildSettings['OTHER_CPLUSPLUSFLAGS'] = '"$(inherited) -std=gnu++20"';
      }
    });
    return c;
  });
}

module.exports = withLlamaRnLocal;

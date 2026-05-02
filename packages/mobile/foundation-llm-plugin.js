// Expo config plugin that registers the local FoundationLLM pod with
// the iOS Podfile during `npx expo prebuild`. The pod itself lives at
// modules/foundation-llm/ — this plugin just splices a one-liner into
// the Podfile so CocoaPods picks it up.
//
// We use a sentinel comment so re-runs are idempotent (matching the
// pattern Expo's autolinking uses for onnxruntime-react-native).

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SENTINEL = '# foundation-llm @generated begin (DO NOT MODIFY)';
const SENTINEL_END = '# foundation-llm @generated end';

function withFoundationLLM(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');

      // If already present, refresh in place; otherwise inject after
      // the `target 'meomd' do` line.
      const block = `${SENTINEL}\n  pod 'FoundationLLM', :path => '../modules/foundation-llm'\n  ${SENTINEL_END}`;

      if (contents.includes(SENTINEL)) {
        const re = new RegExp(`${escapeRegExp(SENTINEL)}[\\s\\S]*?${escapeRegExp(SENTINEL_END)}`);
        contents = contents.replace(re, block);
      } else {
        // Insert right after the `target '<name>' do` line.
        contents = contents.replace(
          /(target '[^']+' do\n)/,
          (_m, line) => `${line}  ${block}\n`,
        );
      }

      fs.writeFileSync(podfilePath, contents);
      return cfg;
    },
  ]);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = withFoundationLLM;

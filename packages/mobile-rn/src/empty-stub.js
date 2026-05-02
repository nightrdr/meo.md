// Stub used by metro.config.js to short-circuit modules that the v1
// scaffold doesn't need (onnxruntime-web, @huggingface/transformers,
// etc.). These get pulled in transitively by @meo/shared/ai but the
// mobile-rn shell defers AI to Phase 2 — see README.
module.exports = new Proxy(
  {},
  {
    get() {
      throw new Error(
        'AI module not wired in mobile-rn v1 — see packages/mobile-rn/README.md',
      );
    },
  },
);

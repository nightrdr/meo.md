import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // loadEnv reads .env / .env.local / .env.<mode>.local from the project root
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    server: { port: 5173 },
    resolve: {
      // Force a single instance of React across all modules.
      dedupe: ['react', 'react-dom'],
    },
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client'],
      // Exclude:
      //   - @meo/shared: workspace package, served via /@fs
      //   - @huggingface/transformers: ESM, ships ONNX wasm/.bin assets;
      //     pre-bundling rewrites paths and breaks the runtime
      exclude: ['@meo/shared', '@huggingface/transformers'],
    },
    define: {
      __DATA_BACKEND__: JSON.stringify(env.VITE_DATA_BACKEND ?? 'supabase'),
      __API_URL__: JSON.stringify(env.VITE_API_URL ?? 'http://localhost:8787'),
      __SUPABASE_URL__: JSON.stringify(env.VITE_SUPABASE_URL ?? 'http://127.0.0.1:54321'),
      __SUPABASE_ANON_KEY__: JSON.stringify(env.VITE_SUPABASE_ANON_KEY ?? ''),
    },
  };
});

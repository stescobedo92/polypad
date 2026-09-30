import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Set by the Tauri CLI when the dev server must be reachable from another device.
const host = process.env.TAURI_DEV_HOST;
// Set by the Tauri CLI for `tauri dev` and `tauri build --debug`.
const isDebugBuild = Boolean(process.env.TAURI_ENV_DEBUG);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Keep Rust compiler output visible in the terminal.
  clearScreen: false,
  server: {
    // Must match build.devUrl in src-tauri/tauri.conf.json.
    port: 5173,
    strictPort: true,
    host: host ?? false,
    ...(host ? { hmr: { protocol: "ws", host, port: 5174 } } : {}),
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Vite's default target (Baseline Widely Available: Chrome 111, Safari 16.4) matches the
    // browser floor of Tailwind CSS v4, so no lower target is useful. See docs/adr/0004.
    minify: !isDebugBuild,
    sourcemap: isDebugBuild,
    // Small fonts would otherwise be inlined as data: URIs, which the CSP (font-src 'self')
    // rejects. Returning undefined keeps Vite's default size rule for every other asset.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The Tauri CLI sets the string "true" for `tauri dev` and `tauri build --debug`, and "false"
// for release builds, so a truthiness check would ship unminified bundles with source maps.
const isDebugBuild = process.env.TAURI_ENV_DEBUG === "true";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Keep Rust compiler output visible in the terminal.
  clearScreen: false,
  server: {
    // Must match build.devUrl in src-tauri/tauri.conf.json.
    port: 5173,
    strictPort: true,
    // Desktop only: HMR stays on this origin, the one devCsp allows. The template's
    // TAURI_DEV_HOST branch serves physical mobile devices, which PolyPad does not target.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // Plain prefixes: Vite matches with startsWith, so a trailing "*" would be taken literally.
  envPrefix: ["VITE_", "TAURI_ENV_"],
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

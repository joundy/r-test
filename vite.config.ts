import react from "@vitejs/plugin-react-swc";
import { resolve } from "path";
import { defineConfig } from "vite";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import dts from "vite-plugin-dts";
// import eslint from "vite-plugin-eslint";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
      },
      formats: ["es"],
    },
  },
  plugins: [
    react(),
    dts({
      insertTypesEntry: true,
    }),
    // eslint(),
    cssInjectedByJsPlugin(),
    nodePolyfills({
      globals: {
        // required for ordit-sdk functionality
        Buffer: true,
      },
    }),
  ],
});

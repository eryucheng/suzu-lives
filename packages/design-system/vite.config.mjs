import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: false,
    lib: {
      entry: path.join(HERE, "src", "lib.ts"),
      name: "SuzuDesignSystem",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "suzu-design-system.js" : "suzu-design-system.umd.cjs"),
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"],
      output: {
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
          "react/jsx-runtime": "ReactJSXRuntime",
        },
        assetFileNames: (asset) => (asset.name?.endsWith(".css") ? "suzu-design-system.css" : "assets/[name]-[hash][extname]"),
      },
    },
  },
});

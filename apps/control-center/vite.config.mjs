import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function developmentStyleCsp() {
  return {
    name: "suzu-development-style-csp",
    transformIndexHtml(html, context) {
      const devStylePolicy = context.server ? " 'unsafe-inline'" : "";
      return html.replace("__SUZU_DEV_INLINE_STYLE__", devStylePolicy);
    },
  };
}

export default defineConfig({
  root: path.join(HERE, "src"),
  publicDir: path.join(HERE, "assets"),
  base: "./",
  plugins: [react(), developmentStyleCsp()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: path.join(HERE, "renderer"),
    emptyOutDir: true,
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
    alias: [
      { find: "@/api", replacement: path.resolve(root, "../api") },
      { find: "@", replacement: root },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 3000,
    strictPort: false,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787" },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 3000,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787" },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

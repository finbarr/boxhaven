import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    // The router plugin must run before react() so file routes are generated
    // and transformed first. Paths resolve against the vite root ("app").
    tanstackRouter({
      target: "react",
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
    }),
    react(),
  ],
  root: "app",
  build: {
    outDir: "../dist-app",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: process.env.VITE_BOXHAVEN_API_URL || "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/healthz": {
        target: process.env.VITE_BOXHAVEN_API_URL || "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});

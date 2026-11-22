import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The built files are served by the Smelt process itself. During development,
// `npm run dev` proxies the API to a Smelt running on its default port.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
  server: { proxy: { "/api": "http://127.0.0.1:4780" } },
});

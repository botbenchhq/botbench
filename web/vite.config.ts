import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The built files are served by the Botbench process itself. During development,
// `npm run dev` proxies the API to a Botbench running on its default port.
// Tailwind 4 runs as a Vite plugin (ADR 0012); "@" is the alias shadcn/ui's copied components import through.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
  server: { proxy: { "/api": "http://127.0.0.1:4780" } },
});

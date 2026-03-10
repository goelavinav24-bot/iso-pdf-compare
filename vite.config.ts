import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: "dist" },
  optimizeDeps: {
    // Let Vite pre-bundle PDF.js entry points for both dev and build
    include: ["pdfjs-dist/build/pdf", "pdfjs-dist/build/pdf.worker.mjs"],
  },
  // PDF.js v4 worker is ESM
  worker: { format: "es" },
});

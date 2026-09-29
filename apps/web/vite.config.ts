import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "apps/web",
  envDir: "../..",
  publicDir: "static",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

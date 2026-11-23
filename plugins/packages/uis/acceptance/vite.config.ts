import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  plugins: [tailwindcss()],
  server: { host: "127.0.0.1", port: 4187, strictPort: true },
  build: { outDir: "../dist/acceptance", emptyOutDir: true },
});

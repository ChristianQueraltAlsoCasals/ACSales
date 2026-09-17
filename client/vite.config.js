import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Frontend :5173 → proxy /api → backend :3000
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
    // Perfil Edge de Playwright (bc_automation) — no vigilar (EBUSY)
    watch: {
      ignored: [
        path.resolve(__dirname, "../bc_automation/**"),
        "**/bc_automation/**",
      ],
    },
  },
});

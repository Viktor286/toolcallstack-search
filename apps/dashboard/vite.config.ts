import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const gateway = process.env.GATEWAY_URL ?? "http://localhost:4310";

export default defineConfig({
  // The gateway serves the built app under /ui.
  base: "/ui/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  server: {
    port: 4311,
    // In development the API is the locally running gateway.
    proxy: { "/v1": gateway, "/health": gateway },
  },
});

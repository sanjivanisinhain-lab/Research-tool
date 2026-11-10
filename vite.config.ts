import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";

// Plain Vite config (replaces the Lovable wrapper, which is not installable outside Lovable).
export default defineConfig({
  server: { port: 5173, proxy: { "/api": `http://localhost:${process.env["API_PORT"] ?? 8787}` } },
  plugins: [tsConfigPaths(), tanstackStart({ server: { entry: "server" } }), viteReact(), tailwindcss()],
});

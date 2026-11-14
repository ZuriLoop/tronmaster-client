import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Served from the root of its own domain; set BASE_PATH to host it under a subpath.
  base: process.env.BASE_PATH ?? "/",
  build: { target: "es2022", sourcemap: true },
  resolve: {
    // Use SDK source in dev so the app tracks edits without a rebuild.
    alias: process.env.SDK_DIST ? {} : { "@tron-paymaster/sdk": new URL("../sdk/src/index.ts", import.meta.url).pathname },
  },
});

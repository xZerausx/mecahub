import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // The fake hub of the browser tests exists only on the dev server. A build pins the flag to "0"
  // whatever the environment says, so the branch (and the fake hub module behind its dynamic import)
  // is dead code and never reaches the bundle: e2e/hub-source.spec.ts reads the shipped bundle.
  define: command === "build" ? { "import.meta.env.VITE_E2E_FAKE_HUB": JSON.stringify("0") } : {},
}));

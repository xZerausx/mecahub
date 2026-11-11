import { defineConfig } from "vitest/config";

// All projects run in Node. lwp3, hub and runtime must stay DOM-free
// (enforced by their tsconfig `lib` and by ESLint).
const projects = [
  ...["lwp3", "transport", "hub", "runtime", "blocks", "simulator"].map((name) => ({
    root: `packages/${name}`,
    name,
    include: ["src/**/*.test.ts"],
  })),
  { root: "apps/mobile", name: "mobile", include: ["src/**/*.test.ts"] },
  { root: "apps/web", name: "web", include: ["src/**/*.test.{ts,tsx}"] },
].map(({ root, name, include }) => ({
  test: { name, root, include, environment: "node" as const },
}));

export default defineConfig({ test: { projects } });

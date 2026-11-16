import { defineConfig, devices } from "@playwright/test";

const PORT = 5199;
const HOST = "127.0.0.1"; // not "localhost": it may resolve to ::1 while the server listens on IPv4
const PROD = Boolean(process.env.E2E_PROD); // CI: test the production build, not the dev server

// `exec` makes the server the process Playwright manages, so stopping it really stops it (a
// wrapper shell or `pnpm exec` can leave the server running and block the port for the next run).
const serve = PROD
  ? `cd apps/web && ./node_modules/.bin/vite build && exec ./node_modules/.bin/vite preview --host ${HOST} --port ${PORT} --strictPort`
  : `cd apps/web && exec ./node_modules/.bin/vite --host ${HOST} --port ${PORT} --strictPort`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  // Never hang: every test, the whole run and the server start have a hard limit.
  timeout: 60_000,
  globalTimeout: 10 * 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://${HOST}:${PORT}`, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: serve,
    url: `http://${HOST}:${PORT}`,
    // A stale server on the port would be reused silently (this is how a run can hang or test old
    // code): fail fast instead, in CI and locally.
    reuseExistingServer: false,
    timeout: PROD ? 180_000 : 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});

import { defineConfig, devices } from '@playwright/test'

// The suite drives a *production* build served by FastAPI, exactly as
// `docs/ui-regression-scenarios.md` tells a human to do it. `mise run e2e` builds
// `frontend/dist` immediately before this config starts the server, so a test can
// never pass against a stale build — the trap behind the checklist's port-8100
// warning. That build clears `VITE_API_BASE_URL`, because a developer's local
// `frontend/.env` would otherwise bake a cross-origin API base into the bundle and
// send every request to whatever is holding port 8100.
//
// Port 8124, not the checklist's 8123, so an automated run cannot collide with a
// manual session someone has open in a browser next to it.
const PORT = 8124
const BASE_URL = `http://127.0.0.1:${PORT}`

// Playwright's cwd is this file's directory; the server commands are written from
// the repository root, as the checklist writes them.
const REPO_ROOT = '..'

export default defineConfig({
  testDir: './e2e',
  // A promoted scenario is a settled expectation, so a retry would only hide
  // flakiness. Failures must be reproducible on the first run.
  retries: 0,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  // A single uvicorn serves every worker, so an assertion can wait on a queued
  // comparison. 15s is generous for an app that answers in milliseconds, and it
  // keeps a loaded CI box from failing a correct suite that cannot retry.
  expect: { timeout: 15_000 },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Must come *after* the spread: `Desktop Chrome` carries its own 1280×720
        // viewport, and a project's `use` wins over the top-level one. The
        // connection pill hides its own text below 460px and the metric grid
        // reflows at 900px (App.css), so pin the layout a human actually reads.
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
  webServer: {
    // Serving only. `mise run e2e` builds `frontend/dist` first, where a compiler
    // error is a visible failure rather than a webServer start-up timeout with no
    // diagnostics. `--no-access-log` silences the per-request spam at the source,
    // so stdout can stay piped and any real uvicorn output is readable — the HTTP
    // detail that matters is reported by `support/traffic.ts`, which fails a test
    // on any non-2xx engine call and names the status and path.
    command: `KCAP_FRONTEND_DIR=frontend/dist uv run uvicorn kcap.api:app --host 127.0.0.1 --port ${PORT} --no-access-log`,
    cwd: REPO_ROOT,
    url: BASE_URL,
    // Never reuse: a server already on this port is not one this run started, and
    // it may be serving a `dist` from another working tree.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})

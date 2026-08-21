import type { Page } from '@playwright/test'

/**
 * Watches the one page the suite drives, for two things a scenario cannot see
 * for itself.
 *
 * **Problems.** `docs/ui-regression-scenarios.md` makes it a standing rule that
 * "a scenario that renders correctly but logs a 422 is a failure". Every promoted
 * test inherits that rule from here rather than restating it, and the fixture
 * fails the test on teardown if anything landed in `problems`.
 *
 * **Settling.** An edit is debounced ~160 ms and then POSTed to `/v1/compare`;
 * the projection on screen belongs to the *previous* answer until that round trip
 * lands. A test that reads a pod count too early would compare against stale
 * pixels — and a test asserting "nothing changed" would then pass for the wrong
 * reason. `settled()` waits for the screen to have caught up.
 */
export class Traffic {
  readonly problems: string[] = []
  private inFlight = 0
  private started = 0

  constructor(page: Page) {
    page.on('console', (message) => {
      if (message.type() === 'error') this.problems.push(`console error: ${message.text()}`)
    })
    page.on('pageerror', (error) => {
      this.problems.push(`uncaught page error: ${error.message}`)
    })

    page.on('request', (request) => {
      if (isEngineCall(request.url())) {
        this.started += 1
        this.inFlight += 1
      }
    })
    page.on('requestfailed', (request) => {
      if (!isEngineCall(request.url())) return
      this.inFlight -= 1
      // kcap aborts the in-flight comparison whenever the config changes again
      // (the `AbortController` cleanup in App.tsx's compare effect), so an
      // aborted request is the app working as designed, not an engine complaint.
      // Reporting it would fail tests for editing two fields in a row.
      const reason = request.failure()?.errorText ?? 'unknown'
      if (reason === 'net::ERR_ABORTED') return
      this.problems.push(`${new URL(request.url()).pathname} failed: ${reason}`)
    })
    page.on('requestfinished', (request) => {
      if (isEngineCall(request.url())) this.inFlight -= 1
    })
    page.on('response', (response) => {
      if (isEngineCall(response.url()) && !response.ok()) {
        this.problems.push(`${response.status()} from ${new URL(response.url()).pathname}`)
      }
    })
  }

  /** A marker to take *before* an edit and hand back to {@link isSettled} after it. */
  mark(): number {
    return this.started
  }

  /**
   * True once an engine call has *started* since `mark` and nothing is still in
   * flight — i.e. the projection on screen answers the edit just made.
   *
   * Counting starts rather than completions is the load-bearing detail. If a call
   * were already in flight when `mark` was taken, its completion would satisfy a
   * "one more has finished" test during the ~160 ms before the new edit's own
   * request even leaves the browser, and the reads that followed would be of the
   * previous answer. A request in flight at `mark` time is already counted in
   * `started`, so it can never stand in for the one the edit is waiting on.
   *
   * This assumes the edit really does reach the engine. An edit that commits the
   * value already on screen sends nothing, and a caller waiting on it would time
   * out — correctly, since there would be no new answer to read.
   */
  isSettled(mark: number): boolean {
    return this.started > mark && this.isIdle()
  }

  /** True when no engine call is outstanding, whenever it was started. */
  isIdle(): boolean {
    return this.inFlight === 0
  }
}

function isEngineCall(url: string): boolean {
  return new URL(url).pathname.startsWith('/v1/')
}

import { test as base, expect } from '@playwright/test'
import { Kcap } from './kcap'
import { Traffic } from './traffic'

/**
 * The suite's entry point: `import { test, expect } from './support/fixture'`.
 *
 * Every test gets a fresh page on the shipped defaults — which is what the
 * checklist's "press Reset between scenarios" achieves for a human — plus the
 * console/HTTP guard, which fails the test if the screen looked right while the
 * browser console or the engine said otherwise.
 */
export const test = base.extend<{ kcap: Kcap }>({
  // Playwright names this second argument `use` by convention, but it is
  // positional — and `use` trips the `react-hooks/rules-of-hooks` lint rule, which
  // reads any `use*` call as a React hook. `runTest` says what it does anyway.
  kcap: async ({ page }, runTest) => {
    const traffic = new Traffic(page)
    await runTest(new Kcap(page, traffic))
    expect(traffic.problems, 'the scenario rendered, but the browser or the engine complained').toEqual([])
  },
})

export { expect }

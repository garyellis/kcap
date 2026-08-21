import { readFileSync } from 'node:fs'

const CHECKLIST = new URL('../../../docs/ui-regression-scenarios.md', import.meta.url)

/**
 * Read fixture F1–F4 out of `docs/ui-regression-scenarios.md`.
 *
 * The promoted tests paste the *same bytes* a human pastes. Copying the fixtures
 * into this directory would let the two drift, and a drifted fixture is the worst
 * of both worlds: the suite stays green while the manual scenario it claims to
 * automate now tests something else. Renaming or reformatting the doc's fixture
 * section fails loudly here, which is the correct outcome.
 */
export function checklistFixture(id: 'F1' | 'F2' | 'F3' | 'F4'): string {
  const markdown = readFileSync(CHECKLIST, 'utf8')

  const heading = markdown.indexOf(`\n### ${id} —`)
  if (heading === -1) throw new Error(`No "### ${id} — ..." heading in ${CHECKLIST.pathname}`)

  // Bounded by the next heading. An unbounded search would walk past a fence that
  // had been removed or relabelled and quietly return the *following* fixture's
  // JSON — the suite would then import the wrong bytes and still pass, which is
  // the exact failure this module exists to prevent.
  const nextHeading = markdown.indexOf('\n### ', heading + 1)
  const limit = nextHeading === -1 ? markdown.length : nextHeading

  const fence = markdown.indexOf('```json\n', heading)
  const start = fence + '```json\n'.length
  const end = fence === -1 ? -1 : markdown.indexOf('```', start)
  if (fence === -1 || end === -1 || end > limit) {
    throw new Error(`No json code fence under "### ${id}" in ${CHECKLIST.pathname}`)
  }

  const document = markdown.slice(start, end).trim()
  JSON.parse(document) // fail here, not inside the browser, if the doc's JSON is broken
  return document
}

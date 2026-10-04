/**
 * Report JSDoc block lines that are missing the leading `*`.
 *
 * A line inside `/** ... *\/` that does not start with optional whitespace and
 * `*` ends the DocBlock early for most parsers: the rest of the comment becomes
 * code and the renderer shows a truncated description. This scans every `.ts`
 * source for that shape.
 *
 * Usage: node scripts/check-jsdoc.mjs
 *
 * @module dsh-bwrap-sandbox/check-jsdoc
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('../src', import.meta.url))
const OPEN = /^(\s*)\/\*\*$/u
const WELL_FORMED = /^\s*\*(?:\/)?$/u

/** Every `.ts` file under `src`. */
function sources() {
  return readdirSync(SOURCE, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    .map(entry => join(SOURCE, entry.name))
}

/** Lines inside a JSDoc block that are not `*`-prefixed. */
function offenders(path) {
  const found = []
  let inBlock = false
  readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
    if (!inBlock) {
      if (OPEN.test(line)) inBlock = true
      return
    }
    if (line.trimEnd().endsWith('*/')) {
      // The closing line must itself be `*`-prefixed; `*/` alone on its own
      // line is what a malformed block looks like.
      if (!WELL_FORMED.test(line)) found.push({ line: index + 1, text: line })
      inBlock = false
      return
    }
    if (!line.trimStart().startsWith('*')) found.push({ line: index + 1, text: line })
  })
  return found
}

let failed = false
for (const path of sources()) {
  for (const { line, text } of offenders(path)) {
    failed = true
    process.stderr.write(`${path.slice(SOURCE.length - 3)}:${String(line)}: JSDoc line is missing its leading "*": ${text.trim()}\n`)
  }
}
if (failed) process.exit(1)
process.stdout.write('check-jsdoc: every JSDoc block is well formed\n')

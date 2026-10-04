/**
 * Regenerate the `guard-bwrap` config block in `cordis.patch.yml` from the
 * argument tables the plugin declares.
 *
 * `dsh --dump-config` prints the composed YAML layers and never expands a
 * schema, so a row prints the `config:` a layer wrote and nothing more. The
 * guard's tables are the one piece of this bundle an operator is expected to
 * copy and edit, and hand-writing a nested YAML mapping from a README table is
 * exactly where a dropped `grep` or `lsp` entry hides. Emitting the block from
 * `DEFAULT_PATH_ARGUMENTS` / `DEFAULT_PATH_ARRAY_ARGUMENTS` puts the tables in
 * the dump, keeps the plugin's schema defaults as the single source, and makes
 * a stale copy impossible to commit: `npm test` fails when the block differs
 * from what this script would write.
 *
 * Only these two fields are emitted. A general "dump every schema default"
 * would pin values that must stay environment-derived — `fs-bwrap`'s `cwd`
 * defaults to the process working directory, and the store roots default to
 * `$DSH_HOME`, which is not known when this file is generated.
 *
 * Usage:
 *   node scripts/sync-patch-config.mjs          # rewrite the block
 *   node scripts/sync-patch-config.mjs --check  # exit 1 when it is stale
 *
 * @module dsh-bwrap-sandbox/sync-patch-config
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PATH_ARGUMENTS, DEFAULT_PATH_ARRAY_ARGUMENTS } from '../lib/guard.js'

/** Path of the bundle patch this script owns. */
export const PATCH_PATH = join(fileURLToPath(new URL('..', import.meta.url)), 'cordis.patch.yml')

/** First line of the generated region, at the indentation of a patch row's keys. */
export const REGION_START = '      # BEGIN GENERATED guard-bwrap config'

/** Last line of the generated region. */
export const REGION_END = '      # END GENERATED guard-bwrap config'

/** Render one `key: value` mapping level. */
function mapping(entries, indent) {
  return entries.map(([key, value]) => `${' '.repeat(indent)}${key}: ${value}`)
}

/**
 * Render the generated region, markers included.
 * @returns the region's lines, joined with newlines and with no trailing newline.
 */
export function renderRegion() {
  return [
    REGION_START,
    '      config:',
    '        pathArguments:',
    ...mapping(Object.entries(DEFAULT_PATH_ARGUMENTS), 10),
    '        pathArrayArguments:',
    ...mapping(Object.entries(DEFAULT_PATH_ARRAY_ARGUMENTS), 10),
    REGION_END,
  ].join('\n')
}

/**
 * Replace the marked region of `text` with `region`.
 * @param text - the whole patch file.
 * @param region - the rendered region.
 * @returns the updated file contents.
 * @throws when the region markers are missing or out of order.
 */
export function replaceRegion(text, region) {
  const start = text.indexOf(REGION_START)
  const end = text.indexOf(REGION_END)
  if (start < 0 || end < start) {
    throw new Error(`cordis.patch.yml is missing the generated region between "${REGION_START}" and "${REGION_END}"`)
  }
  return text.slice(0, start) + region + text.slice(end + REGION_END.length)
}

/**
 * Read the patch file and report whether its generated region is current.
 * @returns the file contents and the rendered region.
 */
export function readPatch() {
  return { text: readFileSync(PATCH_PATH, 'utf8'), region: renderRegion() }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { text, region } = readPatch()
  const current = replaceRegion(text, region)
  if (process.argv.includes('--check')) {
    if (current !== text) {
      process.stderr.write('sync-patch-config: cordis.patch.yml is stale; run `npm run sync:patch`\n')
      process.exit(1)
    }
    process.stdout.write('sync-patch-config: cordis.patch.yml is current\n')
  } else if (current === text) {
    process.stdout.write('sync-patch-config: cordis.patch.yml is already current\n')
  } else {
    writeFileSync(PATCH_PATH, current)
    process.stdout.write('sync-patch-config: cordis.patch.yml updated\n')
  }
}

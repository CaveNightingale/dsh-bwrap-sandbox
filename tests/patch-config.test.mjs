import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PATH_ARGUMENTS,
  DEFAULT_PATH_ARRAY_ARGUMENTS,
  Config,
} from '../lib/guard.js'
import { PATCH_PATH, readPatch, renderRegion, replaceRegion } from '../scripts/sync-patch-config.mjs'

test('the patch carries the guard tables, so --dump-config prints a template', () => {
  const { text } = readPatch()
  // `--dump-config` prints YAML layers and expands no schema, so the tables have
  // to be in the layer for an operator to copy them.
  assert.ok(text.includes('pathArguments:'), 'the guard row carries pathArguments')
  assert.ok(text.includes('pathArrayArguments:'), 'the guard row carries pathArrayArguments')
  for (const tool of Object.keys(DEFAULT_PATH_ARGUMENTS)) {
    assert.ok(text.includes(`\n          ${tool}: `), `${tool} is printed`)
  }
  assert.ok(text.includes('\n          present: files'), 'present is printed')
})

test('the generated region is current, so the template cannot drift from the schema default', () => {
  const { text, region } = readPatch()
  assert.equal(
    replaceRegion(text, region),
    text,
    'run `npm run sync:patch` after changing DEFAULT_PATH_ARGUMENTS or DEFAULT_PATH_ARRAY_ARGUMENTS',
  )
})

test('the region renders the schema defaults exactly', () => {
  const region = renderRegion()
  for (const [tool, argument] of Object.entries(DEFAULT_PATH_ARGUMENTS)) {
    assert.ok(region.includes(`          ${tool}: ${argument}`), `${tool} → ${argument}`)
  }
  for (const [tool, argument] of Object.entries(DEFAULT_PATH_ARRAY_ARGUMENTS)) {
    assert.ok(region.includes(`          ${tool}: ${argument}`), `${tool} → ${argument}`)
  }
  // The same tables the plugin falls back to when the field is omitted.
  assert.deepEqual(Config({}).pathArguments, { ...DEFAULT_PATH_ARGUMENTS })
})

test('a missing or reordered marker is reported rather than silently rewriting', () => {
  assert.throws(() => replaceRegion('- id: x\n', 'anything'), /missing the generated region/)
  assert.equal(typeof PATCH_PATH, 'string')
})

test('the patch disables the rows whose execution world is the host', () => {
  const { text } = readPatch()
  // A `disabled: true` here is a composition decision, not an implementation
  // detail: each of these spawns or binds on the harness host, and a tool whose
  // subprocess never sees the namespace cannot be repaired by a config value.
  for (const id of ['sandbox', 'bash-sandbox', 'fs-sandbox', 'spill-local', 'tool-fs-search']) {
    assert.ok(text.includes(`- id: ${id}\n  disabled: true`), `${id} is disabled`)
  }
  // The search tools are the only disabled row that removes model-visible tools.
  assert.ok(text.includes('- id: tool-fs-search\n  disabled: true'), 'the search row is disabled')
})

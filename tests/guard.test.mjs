import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  Config,
  DEFAULT_PATH_ARGUMENTS,
  DEFAULT_PATH_ARRAY_ARGUMENTS,
  apply as applyGuard,
  resolveArgumentTables,
} from '../lib/guard.js'

/**
 * A workspace whose host name differs from the name the sandbox shows.
 *
 * The guard anchors its mount table at the deployment's own host directory, so
 * the fixture passes it explicitly rather than relying on the test process's
 * working directory.
 */
const HOST_WORKSPACE = '/home/deepseek/workspace'

/** Install the guard with `config` and return the registered decision function. */
function guardFor(config) {
  const guards = []
  const context = new Context()
  context.provide('tools', { guard: fn => guards.push(fn) })
  applyGuard(context, { workspace: HOST_WORKSPACE, ...config })
  return guards[0]
}

/** A pending call for a tool, as the guard sees it. */
function call(name, args, cwd = '/workspace') {
  return { name, arguments: args, agent: { session: { header: { cwd } } } }
}

/**
 * Assert one refusal is exactly the answer any path the sandbox does not have
 * gets: the caller's own argument, and nothing else. No sandbox counterpart, and
 * no hint that a host spelling was recognized.
 * @param denied - the guard's decision, which must be a denial message.
 * @param argument - the value the guard was given.
 */
function assertHostRefusal(denied, argument) {
  assert.equal(denied, `cannot access ${JSON.stringify(argument)}: not found`)
}

test('the shipped table is the field default, and omitting the field uses it', () => {
  assert.deepEqual(Config({}).pathArguments, { ...DEFAULT_PATH_ARGUMENTS })
  assert.deepEqual(Config({}).pathArrayArguments, { ...DEFAULT_PATH_ARRAY_ARGUMENTS })
  // A partially specified object still defaults the fields it omits.
  const partial = Config({ sessionsRoot: '/tmp/sessions' })
  assert.deepEqual(partial.pathArguments, { ...DEFAULT_PATH_ARGUMENTS })
  assert.equal(partial.sessionsRoot, '/tmp/sessions')
})

test('resolve returns the configured table as the whole table', () => {
  assert.deepEqual(resolveArgumentTables({}).pathArguments, { ...DEFAULT_PATH_ARGUMENTS })

  // Setting the field replaces it: what is named is covered, and nothing else.
  const configured = { notebook_edit: 'file_path', grep: 'pattern' }
  const tables = resolveArgumentTables({ pathArguments: configured, pathArrayArguments: {} })
  assert.deepEqual(tables.pathArguments, configured)
  assert.deepEqual(tables.pathArrayArguments, {})
  assert.equal('read' in tables.pathArguments, false, 'the shipped table is not merged in')
})

test('the resolved tables never alias the schema default', () => {
  const first = resolveArgumentTables({})
  first.pathArguments.grep = 'MUTATED'
  delete first.pathArguments.read
  assert.deepEqual(resolveArgumentTables({}).pathArguments, { ...DEFAULT_PATH_ARGUMENTS })
  assert.deepEqual(Config({}).pathArguments, { ...DEFAULT_PATH_ARGUMENTS })
})

test('a blank name or argument, or a tool in both tables, fails loud', () => {
  assert.throws(() => resolveArgumentTables({ pathArguments: { '  ': 'path' } }), /blank tool name/)
  assert.throws(
    () => resolveArgumentTables({ pathArguments: { grep: '  ' } }),
    /is blank; list the argument it names a path in/,
  )
  assert.throws(
    () => resolveArgumentTables({ pathArguments: { grep: 'path' }, pathArrayArguments: { grep: 'files' } }),
    /listed in both pathArguments and pathArrayArguments/,
  )
})

test('the default table fences the shipped tools', () => {
  const guard = guardFor({})
  for (const [name, args] of [
    ['read', { file_path: '/etc/passwd' }],
    ['write', { file_path: '/etc/passwd' }],
    ['grep', { path: '/etc' }],
    ['glob', { path: '/etc' }],
    ['lsp', { file_path: '/etc/passwd' }],
    ['present', { files: [{ path: '/etc/passwd' }] }],
  ]) {
    assert.match(guard(call(name, args)), /not found/, `${name} is fenced by default`)
  }
  assert.equal(guard(call('grep', { path: '/workspace/src' })), undefined)
  assert.equal(guard(call('present', { files: [{ path: '/workspace/a.txt' }] })), undefined)
  // A tool the table does not name is never inspected.
  assert.equal(guard(call('notebook_edit', { file_path: '/etc/passwd' })), undefined)
})

test('an empty table covers nothing, and a replaced table covers exactly itself', () => {
  // The consequence of replacement, spelled out: the shipped tools are gone.
  const emptied = guardFor({ pathArguments: {}, pathArrayArguments: {} })
  assert.equal(emptied(call('read', { file_path: '/etc/passwd' })), undefined)
  assert.equal(emptied(call('grep', { path: '/etc' })), undefined)
  assert.equal(emptied(call('present', { files: [{ path: '/etc/passwd' }] })), undefined)

  const one = guardFor({ pathArguments: { notebook_edit: 'file_path' }, pathArrayArguments: {} })
  assert.match(one(call('notebook_edit', { file_path: '/etc/passwd' })), /not found/)
  assert.equal(one(call('notebook_edit', { file_path: '/workspace/a.md' })), undefined)
  assert.equal(one(call('grep', { path: '/etc' })), undefined, 'grep is not in the replaced table')
})

test('a configured array tool is read from the argument the table names', () => {
  const guards = guardFor({ pathArguments: {}, pathArrayArguments: { attach: 'files' } })
  assert.match(guards(call('attach', { files: [{ path: '/etc/passwd' }] })), /not found/)
  assert.equal(guards(call('attach', { files: [{ path: '/workspace/a.txt' }] })), undefined)
  // Naming the wrong argument means the call carries nothing to inspect, so a
  // misconfigured entry fences nothing.
  const wrong = guardFor({ pathArguments: {}, pathArrayArguments: { attach: 'items' } })
  assert.equal(wrong(call('attach', { files: [{ path: '/etc/passwd' }] })), undefined)
})

test('a host spelling in a tool argument is refused like any absent path', () => {
  const guard = guardFor({})
  const argument = `${HOST_WORKSPACE}/notes.md`
  const denied = guard(call('read', { file_path: argument }, HOST_WORKSPACE))
  assertHostRefusal(denied, argument)
  // Every candidate the guard cannot place gets this one answer, character for
  // character once the path the caller typed is factored out — a host path that
  // exists, one that does not, a name outside every root, and the mount root
  // itself. Which of them is a host spelling is not recoverable from the reply,
  // so guessing the host workspace path tells the caller nothing.
  const unknowns = [
    `${HOST_WORKSPACE}/notes.md`,
    `${HOST_WORKSPACE}/absent.md`,
    '/totally/made/up',
    HOST_WORKSPACE,
    '/etc/passwd',
  ]
  const shapes = unknowns.map((candidate) => {
    const reply = guard(call('read', { file_path: candidate }, HOST_WORKSPACE))
    assertHostRefusal(reply, candidate)
    return reply.replace(JSON.stringify(candidate), 'PATH')
  })
  assert.equal(new Set(shapes).size, 1, `one answer for every unplaceable path, got ${JSON.stringify(shapes)}`)
  // A name inside the namespace is a different question — the caller already
  // knows /workspace is the namespace root, and existence under it says nothing
  // about host spellings — so it keeps the tool's own answer.
  assert.equal(guard(call('read', { file_path: '/workspace/absent.md' }, HOST_WORKSPACE)), undefined)
  // The same file under its visible name is still allowed, and a relative path
  // belongs to the namespace by definition.
  assert.equal(guard(call('read', { file_path: '/workspace/notes.md' }, HOST_WORKSPACE)), undefined)
  assert.equal(guard(call('read', { file_path: 'notes.md' }, HOST_WORKSPACE)), undefined)
})

test('the working-directory arguments are fenced the same way', () => {
  const guard = guardFor({})
  for (const [name, args, argument] of [
    ['bash', { command: 'ls', workdir: `${HOST_WORKSPACE}/src` }, `${HOST_WORKSPACE}/src`],
    ['pwsh', { command: 'ls', workdir: `${HOST_WORKSPACE}/src` }, `${HOST_WORKSPACE}/src`],
    ['terminal', { command: 'ls', cwd: HOST_WORKSPACE }, HOST_WORKSPACE],
  ]) {
    assertHostRefusal(guard(call(name, args, HOST_WORKSPACE)), argument)
  }
  assert.equal(guard(call('bash', { command: 'ls' }, HOST_WORKSPACE)), undefined)
  assert.equal(guard(call('bash', { command: 'ls', workdir: 'src' }, HOST_WORKSPACE)), undefined)
  assert.equal(guard(call('bash', { command: 'ls', workdir: '/workspace/src' }, HOST_WORKSPACE)), undefined)
})

test('a call without an agent session is fenced against the same mounts', () => {
  const guard = guardFor({})
  /** A pending call with no agent, as the SDK and plugin surfaces produce. */
  const agentless = (name, args) => ({ name, arguments: args })
  // The anchor is the deployment's configured workspace, so placing a path does
  // not need a session. The former early return deferred every agentless call to
  // the backend, which cannot see `grep`, `glob`, `lsp`, `bash`, `pwsh`, or
  // `terminal` — the tools only this guard covers.
  assertHostRefusal(guard(agentless('read', { file_path: `${HOST_WORKSPACE}/notes.md` })), `${HOST_WORKSPACE}/notes.md`)
  assert.match(guard(agentless('read', { file_path: '/etc/passwd' })), /not found/)
  assertHostRefusal(guard(agentless('bash', { command: 'ls', workdir: HOST_WORKSPACE })), HOST_WORKSPACE)
  assert.equal(guard(agentless('read', { file_path: '/workspace/notes.md' })), undefined)
  assert.equal(guard(agentless('bash', { command: 'ls' })), undefined)
})

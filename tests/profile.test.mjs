import assert from 'node:assert/strict'
import test from 'node:test'
import { profileArgs } from '../lib/sandbox.js'

/** The resolved mount profile the provider builds from a validated config. */
const config = {
  systemReadOnlyRoots: ['/usr', '/lib', '/etc'],
  maskedRoots: ['/home', '/root'],
  sessionsRoot: '/home/dev/.dsh/sessions',
  attachmentsRoot: '/home/dev/.dsh/attachments',
  spillRoot: '/home/dev/.dsh/spill',
  privateTmp: true,
  dropEnv: ['DSH_HOME', 'DSH_PROFILE_DIR'],
}

const policy = { mode: 'workspace-write', workspaceRoot: '/home/dev/project' }

/**
 * Index of the first occurrence of a token sequence at or after `from`.
 * @param argv - the argument list.
 * @param sequence - the tokens to find.
 * @param from - the index to start searching at.
 * @returns the index, or -1.
 */
function indexOfSequence(argv, sequence, from = 0) {
  for (let index = from; index + sequence.length <= argv.length; index += 1) {
    if (sequence.every((token, offset) => argv[index + offset] === token)) return index
  }
  return -1
}

test('masking follows the system binds, and every later mount wins at its path', () => {
  const argv = profileArgs(policy, config)
  for (const root of config.systemReadOnlyRoots) {
    assert.ok(indexOfSequence(argv, ['--ro-bind', root, root]) >= 0, `${root} is bound read-only`)
  }
  assert.ok(indexOfSequence(argv, ['--tmpfs', '/lib']) < 0, 'no system root is masked')

  // A later mount replaces an earlier one at the same path, so the masks must
  // come after the binds they must not be shadowed by.
  const lastBind = Math.max(...config.systemReadOnlyRoots.map(root => indexOfSequence(argv, ['--ro-bind', root, root])))
  for (const root of config.maskedRoots) {
    assert.ok(indexOfSequence(argv, ['--tmpfs', root]) > lastBind, `${root} is masked after the system binds`)
  }

  // The stores live under a masked home on this host, and bubblewrap resolves a
  // bind SOURCE in the host namespace, so binding them after the mask is both
  // sufficient and necessary.
  const lastMask = Math.max(...config.maskedRoots.map(root => indexOfSequence(argv, ['--tmpfs', root])))
  assert.ok(indexOfSequence(argv, ['--ro-bind', config.sessionsRoot, '/sessions']) > lastMask)
  assert.ok(indexOfSequence(argv, ['--ro-bind', config.attachmentsRoot, '/attachments']) > lastMask)
  assert.ok(indexOfSequence(argv, ['--ro-bind', config.spillRoot, '/spill']) > lastMask)

  // `/tmp` is masked before the workspace bind, so a workspace that lives under
  // it is still reachable.
  assert.ok(indexOfSequence(argv, ['--tmpfs', '/tmp']) < indexOfSequence(argv, ['--bind', policy.workspaceRoot, '/workspace']))
})

test('the workspace is bound last, then the child is re-anchored', () => {
  const argv = profileArgs(policy, config)
  const workspace = indexOfSequence(argv, ['--bind', policy.workspaceRoot, '/workspace'])
  assert.ok(workspace >= 0)
  assert.ok(indexOfSequence(argv, ['--bind', policy.workspaceRoot, '/workspace'], workspace + 1) < 0, 'bound once')

  assert.ok(indexOfSequence(argv, ['--chdir', '/workspace']) > workspace)
  assert.ok(indexOfSequence(argv, ['--setenv', 'HOME', '/workspace']) > workspace)
  for (const name of config.dropEnv) {
    assert.ok(indexOfSequence(argv, ['--unsetenv', name]) > 0, `${name} is dropped`)
  }
  assert.deepEqual(argv.slice(-6), ['--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent'])
})

test('read-only mode binds the workspace read-only, and privateTmp controls /tmp', () => {
  const argv = profileArgs({ ...policy, mode: 'read-only' }, config)
  assert.ok(indexOfSequence(argv, ['--ro-bind', policy.workspaceRoot, '/workspace']) >= 0)
  assert.ok(indexOfSequence(argv, ['--bind', policy.workspaceRoot, '/workspace']) < 0)
  assert.ok(indexOfSequence(argv, ['--tmpfs', '/tmp']) >= 0)

  const shared = profileArgs({ ...policy, mode: 'read-only' }, { ...config, privateTmp: false })
  assert.ok(indexOfSequence(shared, ['--tmpfs', '/tmp']) < 0)
  // The only difference is the one mask, so the rest of the profile is shared.
  assert.equal(argv.length - shared.length, 2)
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { BwrapSandboxProvider } from '../lib/sandbox.js'
import { profileArgs, unavailableReport } from '../lib/sandbox.js'

/**
 * Build a tree holding every bind source plus the resolved profile config that
 * names it, run `body`, then clean the tree up.
 * @param body - receives the config, one policy, and the tree paths.
 * @returns a promise that settles after `body` and the cleanup.
 */
async function withProfile(body) {
  const root = mkdtempSync(join(tmpdir(), 'bwrap-profile-'))
  const dsh = join(root, 'dsh')
  for (const name of ['sessions', 'attachments', 'spill', 'skills']) mkdirSync(join(dsh, name), { recursive: true })
  mkdirSync(join(root, 'agents'), { recursive: true })
  writeFileSync(join(dsh, 'AGENTS.md'), 'user-global rules\n')
  const workspace = join(root, 'project')
  mkdirSync(workspace)

  const config = {
    systemReadOnlyRoots: ['/usr', '/lib', '/etc'],
    maskedRoots: ['/home', '/root'],
    sessionsRoot: join(dsh, 'sessions'),
    attachmentsRoot: join(dsh, 'attachments'),
    spillRoot: join(dsh, 'spill'),
    agentsHome: join(root, 'agents'),
    skillsRoot: join(dsh, 'skills'),
    userInstructionsFile: join(dsh, 'AGENTS.md'),
    privateTmp: true,
    writableRoots: [],
    dropEnv: ['DSH_HOME', 'DSH_PROFILE_DIR'],
  }
  try {
    await body({ config, policy: { mode: 'workspace-write', workspaceRoot: workspace }, root, dsh, workspace })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

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

test('masking follows the system binds, and every later mount wins at its path', () =>
  withProfile(({ config, policy }) => {
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

    // The stores and the user-level inputs live under a masked home on this host,
    // and bubblewrap resolves a bind SOURCE in the host namespace, so binding
    // them after the mask is both sufficient and necessary.
    const lastMask = Math.max(...config.maskedRoots.map(root => indexOfSequence(argv, ['--tmpfs', root])))
    const sources = [
      [config.sessionsRoot, '/sessions'],
      [config.attachmentsRoot, '/attachments'],
      [config.spillRoot, '/spill'],
      [config.agentsHome, '/agents'],
      [config.skillsRoot, '/skills'],
      [config.userInstructionsFile, '/AGENTS.md'],
    ]
    for (const [source, virtual] of sources) {
      assert.ok(indexOfSequence(argv, ['--ro-bind', source, virtual]) > lastMask, `${virtual} is bound after the masks`)
    }

    // `/tmp` is masked before the workspace bind, so a workspace that lives under
    // it is still reachable.
    assert.ok(indexOfSequence(argv, ['--tmpfs', '/tmp']) < indexOfSequence(argv, ['--bind', policy.workspaceRoot, '/workspace']))
  }))

test('a bind source that does not exist is skipped, not fatal', () =>
  withProfile(({ config, policy, root }) => {
    const missing = profileArgs(policy, {
      ...config,
      systemReadOnlyRoots: [...config.systemReadOnlyRoots, '/no-such-system-root'],
      skillsRoot: join(root, 'no-skills'),
      userInstructionsFile: join(root, 'no-AGENTS.md'),
    })
    // Bubblewrap refuses a profile whose bind source is absent, which would take
    // the whole workspace down; an optional user-global file, an absent agents
    // home, and a system root this distribution does not have may simply not
    // exist.
    assert.ok(indexOfSequence(missing, ['--ro-bind', '/no-such-system-root', '/no-such-system-root']) < 0)
    assert.ok(indexOfSequence(missing, ['--ro-bind', join(root, 'no-skills'), '/skills']) < 0)
    assert.ok(indexOfSequence(missing, ['--ro-bind', join(root, 'no-AGENTS.md'), '/AGENTS.md']) < 0)
    assert.ok(indexOfSequence(missing, ['--ro-bind', config.agentsHome, '/agents']) >= 0)
    assert.deepEqual(missing.slice(-6), ['--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent'])
  }))

test('a writable mount is bound read-write, and the rest stay read-only', () =>
  withProfile(({ config, policy }) => {
    const argv = profileArgs(policy, { ...config, writableRoots: ['/agents'] })
    assert.ok(indexOfSequence(argv, ['--bind', config.agentsHome, '/agents']) >= 0)
    assert.ok(indexOfSequence(argv, ['--ro-bind', config.agentsHome, '/agents']) < 0)
    for (const [source, virtual] of [
      [config.skillsRoot, '/skills'],
      [config.userInstructionsFile, '/AGENTS.md'],
      [config.spillRoot, '/spill'],
    ]) {
      assert.ok(indexOfSequence(argv, ['--ro-bind', source, virtual]) >= 0, `${virtual} stays read-only`)
    }
    // The workspace keeps the mode-dependent bind, which is not a writable root.
    assert.ok(indexOfSequence(argv, ['--bind', policy.workspaceRoot, '/workspace']) >= 0)
  }))

test('the workspace is bound last, then the child is re-anchored', () =>
  withProfile(({ config, policy }) => {
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
  }))

test('a profile bubblewrap refuses fails closed with bubblewrap\u2019s own diagnostic', async t => {
  if (spawnSync('bwrap', ['--version']).status !== 0) {
    t.skip('bwrap is not installed on this host')
    return
  }
  await withProfile(async ({ config }) => {
    const context = new Context()
    const provider = new BwrapSandboxProvider(context, config)
    // The profile binds the session workspace, so a workspace that does not exist
    // is the failure this message has to name rather than swallow: without it an
    // unrunnable host and a malformed profile read the same.
    await assert.rejects(
      provider.confine(['true'], { mode: 'workspace-write', workspaceRoot: '/var/tmp/bwrap-missing-workspace' }),
      error => {
        assert.match(error.message, /Runner failure: .*Can.t find source path/)
        return true
      },
    )
    // The console gets the same reason plus the exact command to reproduce it,
    // because the thrown error only ever surfaces inside the session.
    const logged = context.logger.buffer.map(entry => entry.args.join(' ')).join('\n')
    assert.match(logged, /confined commands are refused\./)
    assert.match(logged, /reason: bwrap: Can.t find source path/)
    assert.match(logged, /reproduce: bwrap --ro-bind \/usr \/usr/)
    assert.match(logged, /--bind \/var\/tmp\/bwrap-missing-workspace \/workspace/)
  })
})

test('the operator report names the reason and a runnable reproduction', () => {
  assert.equal(
    unavailableReport("bwrap: setting up uid map: Permission denied", ['bwrap', '--ro-bind', '/a b', '/a b', '--', 'true']),
    [
      'dsh-bwrap-sandbox: bwrap cannot build the sandbox profile on this host, so confined commands are refused.',
      '  reason: bwrap: setting up uid map: Permission denied',
      "  reproduce: bwrap --ro-bind '/a b' '/a b' -- true",
    ].join('\n'),
  )
})

test('read-only mode binds the workspace read-only, and privateTmp controls /tmp', () =>
  withProfile(({ config, policy }) => {
    const argv = profileArgs({ ...policy, mode: 'read-only' }, config)
    assert.ok(indexOfSequence(argv, ['--ro-bind', policy.workspaceRoot, '/workspace']) >= 0)
    assert.ok(indexOfSequence(argv, ['--bind', policy.workspaceRoot, '/workspace']) < 0)
    assert.ok(indexOfSequence(argv, ['--tmpfs', '/tmp']) >= 0)

    const shared = profileArgs({ ...policy, mode: 'read-only' }, { ...config, privateTmp: false })
    assert.ok(indexOfSequence(shared, ['--tmpfs', '/tmp']) < 0)
    // The only difference is the one mask, so the rest of the profile is shared.
    assert.equal(argv.length - shared.length, 2)
  }))

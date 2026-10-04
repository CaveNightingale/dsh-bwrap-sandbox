import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceFileSystem } from '../lib/fs.js'
import { apply as applyGuard } from '../lib/guard.js'

/**
 * Build a workspace with the alias shapes the fence must separate, wiring the
 * real backend and the real guard the way the profile does.
 * @param extraRoots - `additionalReadOnlyRoots` for both plugins.
 * @param overrides - further settings, such as `writableRoots`.
 * @returns the temp root, the backend, the guard, and a tool-call builder.
 */
function fixture(extraRoots = [], overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bwrap-fence-'))
  const workspace = join(root, 'ws')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'a.txt'), 'hello\n')
  // An alias OUTSIDE the mounts pointing INTO the workspace.
  mkdirSync(join(root, 'outside'))
  symlinkSync(workspace, join(root, 'outside', 'ws'))
  // A link inside the workspace pointing out of it.
  symlinkSync('/etc', join(workspace, 'escape'))
  // The user-level inputs the harness itself reads through `ctx.fs`.
  mkdirSync(join(root, 'agents', 'skills', 'demo'), { recursive: true })
  writeFileSync(join(root, 'agents', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\nbody\n')
  mkdirSync(join(root, 'skills', 'local'), { recursive: true })
  writeFileSync(join(root, 'skills', 'local', 'SKILL.md'), '---\nname: local\n---\nbody\n')

  const settings = {
    cwd: workspace,
    workspace,
    diffBasisMaxBytes: 10 * 1024 * 1024,
    sessionsRoot: '',
    attachmentsRoot: '',
    agentsHome: join(root, 'agents'),
    skillsRoot: join(root, 'skills'),
    // Deliberately absent: `$DSH_HOME/AGENTS.md` is optional.
    userInstructionsFile: join(root, 'AGENTS.md'),
    additionalReadOnlyRoots: extraRoots,
    writableRoots: [],
    ...overrides,
  }
  const fsContext = new Context()
  fsContext.provide('sandboxPolicy', { defaultMode: 'workspace-write' })
  const backend = new WorkspaceFileSystem(fsContext, settings)

  const guards = []
  const guardContext = new Context()
  guardContext.provide('tools', { guard: fn => guards.push(fn) })
  applyGuard(guardContext, settings)

  return {
    root,
    workspace,
    backend,
    guard: guards[0],
    call: (name, args) => ({ name, arguments: args, agent: { session: { header: { cwd: workspace } } } }),
  }
}

/**
 * Run `body` against a fixture and clean up afterwards.
 * @param extraRoots - `additionalReadOnlyRoots`.
 * @param body - receives the fixture; it is awaited before cleanup.
 * @param overrides - further settings, such as `writableRoots`.
 */
async function withFixture(extraRoots, body, overrides = {}) {
  const context = fixture(extraRoots, overrides)
  try {
    await body(context)
  } finally {
    rmSync(context.root, { recursive: true, force: true })
  }
}

test('a virtual path and a relative path resolve to the virtual view, and a host path is refused', async () => {
  await withFixture([], async ({ workspace, backend }) => {
    for (const path of ['/workspace/src/a.txt', 'src/a.txt']) {
      const target = await backend.resolve(path)
      assert.equal(target.displayPath, '/workspace/src/a.txt')
      assert.equal(target.targetKey, join(workspace, 'src', 'a.txt'))
    }
    // A path that does not exist yet still resolves, so a new write can be checked.
    assert.equal((await backend.resolve('/workspace/src/new.txt')).displayPath, '/workspace/src/new.txt')
    // A host path is not a name here, even when a mount covers the same file:
    // the execution world has one spelling, and `processPath` reports it.
    await assert.rejects(backend.resolve(join(workspace, 'src', 'a.txt')), error => {
      assert.equal(error.code, 'FS_NOT_FOUND')
      return true
    })
  })
})

test('an alias outside the mounts that resolves into the workspace reads as absent', async () => {
  await withFixture([], async ({ root, backend, guard, call }) => {
    const aliased = join(root, 'outside', 'ws', 'src', 'a.txt')
    await assert.rejects(backend.resolve(aliased), error => {
      assert.equal(error.code, 'FS_NOT_FOUND')
      return true
    })
    assert.match(guard(call('read', { file_path: aliased })), /not found/)
  })
})

test('a link inside the workspace that points outside it reads as absent', async () => {
  await withFixture([], async ({ backend, guard, call }) => {
    for (const path of ['/workspace/escape', '/workspace/escape/passwd']) {
      await assert.rejects(backend.resolve(path), error => {
        assert.equal(error.code, 'FS_NOT_FOUND')
        assert.match(error.message, /not found/)
        return true
      })
      assert.match(guard(call('read', { file_path: path })), /not found/)
    }
  })
})

test('paths out of the mount namespace read as absent to both fences', async () => {
  await withFixture([], async ({ backend, guard, call }) => {
    const refused = [
      '/etc/passwd',
      '/sbin/ws/src/a.txt',
      '/workspace/../etc/passwd',
      '/workspace/./../../etc/passwd',
    ]
    for (const path of refused) {
      await assert.rejects(backend.resolve(path), error => {
        assert.equal(error.code, 'FS_NOT_FOUND')
        return true
      })
      assert.match(guard(call('read', { file_path: path })), /not found/)
    }
    assert.match(guard(call('grep', { path: '/' })), /not found/)
  })
})

test('the user-level agents home and DSH skill root are reachable under their virtual names', async () => {
  await withFixture([], async ({ root, backend, guard, call }) => {
    const hostSkill = join(root, 'agents', 'skills', 'demo', 'SKILL.md')
    assert.equal((await backend.resolve('/agents/skills/demo/SKILL.md')).targetKey, hostSkill)
    assert.equal((await backend.resolve('/skills/local/SKILL.md')).displayPath, '/skills/local/SKILL.md')
    // The loader reaches them the same way, because the cwd it joins against is
    // the execution world's spelling rather than the host directory.
    await assert.rejects(backend.resolve(hostSkill), error => {
      assert.equal(error.code, 'FS_NOT_FOUND')
      return true
    })

    assert.equal(guard(call('read', { file_path: '/agents/skills/demo/SKILL.md' })), undefined)
    assert.equal(guard(call('read', { file_path: '/skills/local/SKILL.md' })), undefined)
    assert.match(guard(call('read', { file_path: hostSkill })), /is a host path/)
  })
})

test('the user-global instruction file reads as absent until it exists', async () => {
  await withFixture([], async ({ root, backend, guard, call }) => {
    // `$DSH_HOME/AGENTS.md` is optional. Resolution succeeds the way it does for
    // any file a later write may create; the probe that decides whether the
    // instructions load is `stat`, and it must read as absent.
    const missing = await backend.resolve('/AGENTS.md')
    assert.equal(missing.displayPath, '/AGENTS.md')
    assert.equal(await backend.stat(missing), undefined)

    writeFileSync(join(root, 'AGENTS.md'), 'user-global rules\n')

    const present = await backend.resolve('/AGENTS.md')
    assert.equal(present.targetKey, join(root, 'AGENTS.md'))
    assert.equal((await backend.stat(present)).type, 'file')
    assert.equal(guard(call('read', { file_path: '/AGENTS.md' })), undefined)
    // Its host spelling is not a name this session has.
    assert.match(guard(call('read', { file_path: join(root, 'AGENTS.md') })), /is a host path/)
  })
})

test('a directory listing reports every child under its virtual name', async () => {
  await withFixture([], async ({ workspace, backend }) => {
    const root = await backend.resolve('/workspace')
    const entries = await backend.listDir(root)
    const byName = Object.fromEntries(entries.map(entry => [entry.name, entry.target.displayPath]))
    assert.equal(byName.src, '/workspace/src')
    // `str_replace_editor` prints these paths verbatim, so a host spelling here
    // would be the one host path the model reads without naming one itself.
    for (const path of Object.values(byName)) {
      assert.match(path, /^\/workspace\//)
      assert.ok(!path.includes(workspace), `${path} names no host directory`)
    }
    // The link out of the workspace is not listed: its target would take a
    // follow-up operation outside the fence, and `read` refuses it anyway.
    assert.equal('escape' in byName, false)

    const children = await backend.listDir(await backend.resolve('/workspace/src'))
    assert.deepEqual(children.map(entry => entry.target.displayPath), ['/workspace/src/a.txt'])
  })
})

test('the read-only stores stay reachable and workspace calls stay allowed', async () => {
  await withFixture([], async ({ backend, guard, call }) => {
    const target = await backend.resolve('/sessions')
    assert.equal(target.displayPath, '/sessions')
    assert.ok(target.targetKey.endsWith(join('.dsh', 'sessions')))
    assert.equal(guard(call('read', { file_path: '/workspace/src/a.txt' })), undefined)
    assert.equal(guard(call('present', { files: [{ path: '/workspace/src/a.txt' }] })), undefined)
  })
})

test('an extra root admits that tree, and nothing outside it', async () => {
  await withFixture([tmpdir()], async ({ root, workspace, backend, guard, call }) => {
    const spill = join(tmpdir(), 'bwrap-spill-probe.txt')
    assert.equal((await backend.resolve(spill)).displayPath, spill)
    assert.equal(guard(call('read', { file_path: spill })), undefined)
    // The alias now names a path inside the extra root, so it is followed — and
    // lands on the workspace file it already pointed at, granting no new tree.
    assert.equal((await backend.resolve(join(root, 'outside', 'ws', 'src', 'a.txt'))).targetKey, join(workspace, 'src', 'a.txt'))
    assert.match(guard(call('read', { file_path: '/etc/passwd' })), /not found/)
  })
})

test('an extra root that is not a single top-level directory fails loud at load', () => {
  const context = new Context()
  context.provide('tools', { guard: () => {} })
  assert.throws(
    () => applyGuard(context, { additionalReadOnlyRoots: ['/var/tmp'] }),
    /must be a single top-level directory/,
  )
})

test('a writable root accepts a write the policy would deny, and an unlisted one does not', async t => {
  // The policy's writable set is the session workspace plus the platform temp
  // areas, so a mount has to live outside `tmpdir()` for the exception to be
  // observable at all.
  let root
  try {
    root = mkdtempSync('/var/tmp/bwrap-writable-')
  } catch (error) {
    t.skip(`no /var/tmp on this host (${String(error)})`)
    return
  }
  const agents = join(root, 'agents')
  const skills = join(root, 'skills')
  const workspace = join(root, 'ws')
  mkdirSync(join(agents, 'skills', 'demo'), { recursive: true })
  mkdirSync(join(skills, 'local'), { recursive: true })
  mkdirSync(workspace)
  const settings = {
    cwd: workspace,
    diffBasisMaxBytes: 10 * 1024 * 1024,
    sessionsRoot: '',
    attachmentsRoot: '',
    agentsHome: agents,
    skillsRoot: skills,
    userInstructionsFile: join(root, 'AGENTS.md'),
    additionalReadOnlyRoots: [],
  }
  const backendFor = writableRoots => {
    const context = new Context()
    context.provide('sandboxPolicy', { defaultMode: 'workspace-write' })
    return new WorkspaceFileSystem(context, { ...settings, writableRoots })
  }
  const policy = { mode: 'workspace-write', workspaceRoot: workspace }
  const denied = error => {
    assert.equal(error.code, 'FS_SANDBOX_DENIED')
    return true
  }

  try {
    const writable = backendFor(['/agents'])
    const authored = await writable.resolve('/agents/skills/demo/note.md')
    await writable.writeText(authored, 'agent-authored\n', undefined, undefined, policy)
    // The bytes land in the host directory the skill loader reads.
    assert.equal(readFileSync(join(agents, 'skills', 'demo', 'note.md'), 'utf8'), 'agent-authored\n')

    // Without the option the same write is the inherited workspace-only fence.
    const plain = backendFor([])
    await assert.rejects(
      plain.writeText(await plain.resolve('/agents/skills/demo/other.md'), 'no\n', undefined, undefined, policy),
      denied,
    )

    // A mount that is not listed stays read-only, and `read-only` mode denies
    // even a listed one.
    await assert.rejects(
      writable.writeText(await writable.resolve('/skills/local/note.md'), 'no\n', undefined, undefined, policy),
      denied,
    )
    await assert.rejects(
      writable.writeText(authored, 'no\n', undefined, undefined, { mode: 'read-only', workspaceRoot: workspace }),
      denied,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a writable root that names no mount fails loud at load', () => {
  const context = new Context()
  context.provide('tools', { guard: () => {} })
  assert.throws(() => applyGuard(context, { writableRoots: ['/agents/skills'] }), /names no mount/)
})

test('the backend resolves /spill to its configured spillRoot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bwrap-fs-spill-'))
  try {
    const workspace = join(root, 'ws')
    const spillRoot = join(root, 'configured-spill')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(spillRoot, { recursive: true })
    const context = new Context()
    context.provide('sandboxPolicy', { defaultMode: 'workspace-write' })
    const backend = new WorkspaceFileSystem(context, {
      cwd: workspace,
      diffBasisMaxBytes: 10 * 1024 * 1024,
      sessionsRoot: '',
      attachmentsRoot: '',
      spillRoot,
      additionalReadOnlyRoots: [],
    })
    // A row that forgets to forward spillRoot resolves the locator to the
    // default $DSH_HOME/spill instead, while spill-bwrap writes elsewhere.
    const target = await backend.resolve('/spill/session-abc/a1b2-bash.txt')
    assert.equal(target.displayPath, '/spill/session-abc/a1b2-bash.txt')
    assert.equal(target.targetKey, join(spillRoot, 'session-abc', 'a1b2-bash.txt'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

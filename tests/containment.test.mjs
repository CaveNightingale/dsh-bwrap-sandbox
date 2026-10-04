import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
 * @returns the temp root, the backend, the guard, and a tool-call builder.
 */
function fixture(extraRoots = []) {
  const root = mkdtempSync(join(tmpdir(), 'bwrap-fence-'))
  const workspace = join(root, 'ws')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'a.txt'), 'hello\n')
  // An alias OUTSIDE the mounts pointing INTO the workspace.
  mkdirSync(join(root, 'outside'))
  symlinkSync(workspace, join(root, 'outside', 'ws'))
  // A link inside the workspace pointing out of it.
  symlinkSync('/etc', join(workspace, 'escape'))

  const settings = {
    cwd: workspace,
    diffBasisMaxBytes: 10 * 1024 * 1024,
    sessionsRoot: '',
    attachmentsRoot: '',
    additionalReadOnlyRoots: extraRoots,
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
 */
async function withFixture(extraRoots, body) {
  const context = fixture(extraRoots)
  try {
    await body(context)
  } finally {
    rmSync(context.root, { recursive: true, force: true })
  }
}

test('a virtual path, a host path, and a relative path all resolve to the virtual view', async () => {
  await withFixture([], async ({ workspace, backend }) => {
    for (const path of ['/workspace/src/a.txt', join(workspace, 'src', 'a.txt'), 'src/a.txt']) {
      const target = await backend.resolve(path)
      assert.equal(target.displayPath, '/workspace/src/a.txt')
      assert.equal(target.targetKey, join(workspace, 'src', 'a.txt'))
    }
    // A path that does not exist yet still resolves, so a new write can be checked.
    assert.equal((await backend.resolve('/workspace/src/new.txt')).displayPath, '/workspace/src/new.txt')
  })
})

test('an alias outside the mounts that resolves into the workspace is refused', async () => {
  await withFixture([], async ({ root, backend, guard, call }) => {
    const aliased = join(root, 'outside', 'ws', 'src', 'a.txt')
    await assert.rejects(backend.resolve(aliased), error => {
      assert.equal(error.code, 'FS_SANDBOX_DENIED')
      return true
    })
    assert.match(guard(call('read', { file_path: aliased })), /outside every visible root/)
  })
})

test('a link inside the workspace that points outside it is refused', async () => {
  await withFixture([], async ({ backend, guard, call }) => {
    for (const path of ['/workspace/escape', '/workspace/escape/passwd']) {
      await assert.rejects(backend.resolve(path), error => {
        assert.equal(error.code, 'FS_SANDBOX_DENIED')
        assert.match(error.message, /outside every visible root/)
        return true
      })
      assert.match(guard(call('read', { file_path: path })), /outside every visible root/)
    }
  })
})

test('paths out of the mount namespace are refused by both fences', async () => {
  await withFixture([], async ({ backend, guard, call }) => {
    const refused = [
      '/etc/passwd',
      '/sbin/ws/src/a.txt',
      '/workspace/../etc/passwd',
      '/workspace/./../../etc/passwd',
    ]
    for (const path of refused) {
      await assert.rejects(backend.resolve(path), error => {
        assert.equal(error.code, 'FS_SANDBOX_DENIED')
        return true
      })
      assert.match(guard(call('read', { file_path: path })), /path boundary/)
    }
    assert.match(guard(call('grep', { path: '/' })), /is the virtual root, not a file/)
  })
})

test('the read-only stores stay reachable and workspace calls stay allowed', async () => {
  await withFixture([], async ({ backend, guard, call }) => {
    const target = await backend.resolve(join(process.env.HOME, '.dsh', 'sessions'))
    assert.equal(target.displayPath, '/sessions')
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
    assert.match(guard(call('read', { file_path: '/etc/passwd' })), /outside every visible root/)
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

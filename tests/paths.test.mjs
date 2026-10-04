import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FAKE_ROOT,
  PathDeniedError,
  VIRTUAL_ATTACHMENTS,
  VIRTUAL_SESSIONS,
  VIRTUAL_WORKSPACE,
  hostToVirtual,
  isUnder,
  mapPath,
  toVirtualPath,
} from '../lib/paths.js'

/**
 * Run `body` against a host tree with the alias shapes the mapping separates,
 * cleaning the tree up afterwards.
 * @param body - receives the temp root, the workspace, and the mount table.
 */
function withTree(body) {
  const root = mkdtempSync(join(tmpdir(), 'bwrap-paths-'))
  const workspace = join(root, 'ws')
  const sessions = join(root, 'sessions')
  mkdirSync(join(workspace, 'src', 'deep'), { recursive: true })
  mkdirSync(sessions)
  writeFileSync(join(workspace, 'src', 'a.txt'), 'hello\n')
  // An alias OUTSIDE the mounts pointing INTO the workspace, spelled as a host
  // path. Nothing may follow it: it is not under a mount, and `/sbin/ws` is not
  // a mount name either.
  mkdirSync(join(root, 'outside'))
  symlinkSync(workspace, join(root, 'outside', 'ws'))
  // A link inside the workspace pointing out of it.
  symlinkSync('/etc', join(workspace, 'escape'))
  // Links inside the workspace pointing at directories of the workspace, spelled
  // the way a process inside the sandbox would: virtual absolute, and relative.
  symlinkSync('/workspace/src/deep', join(workspace, 'deep-link'))
  symlinkSync('/workspace/src', join(workspace, 'alias'))
  symlinkSync('/workspace/alias', join(workspace, 'chain'))
  symlinkSync('src/a.txt', join(workspace, 'relative'))
  // A link whose target is a HOST path inside the workspace. A confined process
  // cannot follow it — there is no `/tmp` workspace inside the sandbox — so the
  // file tools must not either.
  symlinkSync(workspace, join(workspace, 'host-spelled'))
  // A loop.
  symlinkSync('/workspace/loop', join(workspace, 'loop'))

  const mounts = [
    { host: workspace, virtual: VIRTUAL_WORKSPACE },
    { host: sessions, virtual: VIRTUAL_SESSIONS },
    { host: join(root, 'attachments'), virtual: VIRTUAL_ATTACHMENTS },
  ]
  try {
    body({ root, workspace, sessions, mounts })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the mounts themselves and their descendants map onto host directories', () => {
  withTree(({ workspace, sessions, mounts }) => {
    assert.deepEqual(mapPath('/', mounts), { host: FAKE_ROOT, virtual: '/' })
    assert.deepEqual(mapPath('/workspace', mounts), { host: workspace, virtual: '/workspace' })
    assert.deepEqual(mapPath('/workspace/src/a.txt', mounts), {
      host: join(workspace, 'src', 'a.txt'),
      virtual: '/workspace/src/a.txt',
    })
    assert.deepEqual(mapPath('/sessions', mounts), { host: sessions, virtual: '/sessions' })
    // A file that does not exist yet maps as itself.
    assert.deepEqual(mapPath('/workspace/new.txt', mounts), {
      host: join(workspace, 'new.txt'),
      virtual: '/workspace/new.txt',
    })
  })
})

test('only a mount name may appear at the top level', () => {
  withTree(({ mounts }) => {
    for (const path of ['/etc/passwd', '/sbin/ws/src/a.txt', '/tmp/x', '/workspace-other/x', '/usr']) {
      assert.throws(() => mapPath(path, mounts), PathDeniedError, `${path} must be refused`)
    }
    // An explicit mount is what makes `/tmp` reachable, not a pattern.
    const relaxed = [...mounts, { host: '/tmp', virtual: '/tmp' }]
    assert.deepEqual(mapPath('/tmp/x', relaxed), { host: '/tmp/x', virtual: '/tmp/x' })
  })
})

test('a symlink target is read in the virtual namespace', () => {
  withTree(({ workspace, mounts }) => {
    assert.deepEqual(mapPath('/workspace/alias', mounts), {
      host: join(workspace, 'src'),
      virtual: '/workspace/src',
    })
    assert.deepEqual(mapPath('/workspace/alias/a.txt', mounts), {
      host: join(workspace, 'src', 'a.txt'),
      virtual: '/workspace/src/a.txt',
    })
    // A relative target is relative to the link's own directory.
    assert.deepEqual(mapPath('/workspace/relative', mounts), {
      host: join(workspace, 'src', 'a.txt'),
      virtual: '/workspace/src/a.txt',
    })
    // The same spelling inside the workspace: absolute host links written
    // outside the sandbox, which is what a package manager leaves behind.
    assert.deepEqual(mapPath('/workspace/deep-link', mounts), {
      host: join(workspace, 'src', 'deep'),
      virtual: '/workspace/src/deep',
    })
    // A target no mount covers: refused, because a confined process cannot
    // follow a host path either.
    assert.throws(() => mapPath('/workspace/escape', mounts), PathDeniedError)
    assert.throws(() => mapPath('/workspace/escape/passwd', mounts), PathDeniedError)
    assert.throws(() => mapPath('/workspace/host-spelled', mounts), PathDeniedError)
    assert.throws(() => mapPath('/workspace/host-spelled/src/a.txt', mounts), PathDeniedError)
  })
})

test('`.` keeps the mapped parent and `..` pops the mapped parent', () => {
  withTree(({ workspace, mounts }) => {
    assert.deepEqual(mapPath('/workspace/.', mounts), { host: workspace, virtual: '/workspace' })
    assert.deepEqual(mapPath('/workspace/src/../a.txt', mounts), {
      host: join(workspace, 'a.txt'),
      virtual: '/workspace/a.txt',
    })
    // The workspace's parent is the virtual root, which is not a file.
    assert.deepEqual(mapPath('/workspace/..', mounts), { host: FAKE_ROOT, virtual: '/' })
    assert.deepEqual(mapPath('/..', mounts), { host: FAKE_ROOT, virtual: '/' })
    // ...and nothing can be named from there.
    assert.throws(() => mapPath('/workspace/../etc/passwd', mounts), PathDeniedError)
    assert.throws(() => mapPath('/workspace/../../etc/passwd', mounts), PathDeniedError)
  })
})

test('`..` after a symlink lands at the target parent, not the textual one', () => {
  withTree(({ workspace, mounts }) => {
    // `/workspace/alias` is `/workspace/src`, so `..` is the workspace; a
    // textual reading also gives the workspace here, so the case below is the
    // one that separates the two.
    assert.deepEqual(mapPath('/workspace/alias/..', mounts), { host: workspace, virtual: '/workspace' })

    // A link whose target sits one level deeper: `..` must land on the target's
    // parent (`<ws>/src`), where a textual reading would land on `<ws>`.
    assert.deepEqual(mapPath('/workspace/deep-link/..', mounts), {
      host: join(workspace, 'src'),
      virtual: '/workspace/src',
    })
    assert.deepEqual(mapPath('/workspace/deep-link/../a.txt', mounts), {
      host: join(workspace, 'src', 'a.txt'),
      virtual: '/workspace/src/a.txt',
    })
  })
})

test('a symlink chain is followed and a loop is refused', () => {
  withTree(({ workspace, mounts }) => {
    assert.deepEqual(mapPath('/workspace/chain/a.txt', mounts), {
      host: join(workspace, 'src', 'a.txt'),
      virtual: '/workspace/src/a.txt',
    })
    assert.throws(() => mapPath('/workspace/loop', mounts), PathDeniedError)
    assert.throws(() => mapPath('/workspace/loop/x', mounts), PathDeniedError)
  })
})

test('a host path is rewritten through the mount table, and only there', () => {
  withTree(({ root, workspace, sessions, mounts }) => {
    assert.equal(hostToVirtual(join(workspace, 'src', 'a.txt'), mounts), '/workspace/src/a.txt')
    assert.equal(hostToVirtual(workspace, mounts), '/workspace')
    assert.equal(hostToVirtual(join(sessions, 's1.jsonl'), mounts), '/sessions/s1.jsonl')
    // The alias is under no mount, and `/sbin/ws/...` names no mount either.
    const aliased = join(root, 'outside', 'ws', 'src', 'a.txt')
    assert.equal(hostToVirtual(aliased, mounts), undefined)
    assert.throws(() => mapPath(toVirtualPath(aliased, '/workspace'), mounts), PathDeniedError)
  })
})

test('relative paths join the virtual cwd without collapsing `..` textually', () => {
  assert.equal(toVirtualPath('src/a.txt', '/workspace'), '/workspace/src/a.txt')
  assert.equal(toVirtualPath('/etc/passwd', '/workspace'), '/etc/passwd')
  assert.equal(toVirtualPath('link/../x', '/workspace'), '/workspace/link/../x')
})

test('a relative virtual path is refused rather than guessed at', () => {
  withTree(({ mounts }) => {
    assert.throws(() => mapPath('src/a.txt', mounts), PathDeniedError)
  })
})

test('isUnder compares whole path segments', () => {
  assert.equal(isUnder('/a/b/c', '/a/b'), true)
  assert.equal(isUnder('/a/b', '/a/b'), true)
  assert.equal(isUnder('/a/b/c', '/a/b/'), true)
  assert.equal(isUnder('/a/bc', '/a/b'), false)
  assert.equal(isUnder('/a', '/a/b'), false)
  assert.equal(isUnder('/', '/'), true)
})

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { BwrapSpillStore, encodeSegment, sessionDirectoryName } from '../lib/spill.js'
import { buildMounts } from '../lib/mounts.js'
import { mapPath } from '../lib/paths.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Run `body` against an isolated spill root, cleaning it up afterwards.
 * @param body - receives the host root and a request builder; it is awaited.
 */
async function withRoot(body) {
  const root = mkdtempSync(join(tmpdir(), 'bwrap-spill-'))
  const request = (overrides = {}) => ({
    owner: { sessionId: 'sess-1' },
    source: { kind: 'tool', toolName: 'bash', callId: 'call-1', label: 'result' },
    suggestedName: 'bash.txt',
    content: 'the full output\n',
    ...overrides,
  })
  try {
    await body({ root, request })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Activate the store against `root` and return the registered service. */
async function storeFor(root, config = {}) {
  const ctx = new Context()
  await ctx.plugin(BwrapSpillStore, { spillRoot: root, cleanupPeriodDays: 0, ...config })
  return ctx.spillStore
}

/** Write a file with an mtime `ageDays` in the past. */
function writeAged(path, content, ageDays) {
  writeFileSync(path, content)
  const when = (Date.now() - ageDays * DAY_MS) / 1000
  utimesSync(path, when, when)
}

test('saveText writes the bytes and reports a virtual locator for them', async () => {
  await withRoot(async ({ root, request }) => {
    const store = await storeFor(root)
    const ref = await store.saveText(request({ content: '完整输出\n' }))

    assert.equal(ref.bytes, Buffer.byteLength('完整输出\n', 'utf8'))
    assert.equal(ref.retrievalHint, 'Use read with offset/limit, or grep this path to search within it.')
    assert.ok(ref.locator.startsWith('/spill/'), `locator is virtual: ${ref.locator}`)

    // The locator must name the file the store wrote — that is the whole point
    // of replacing the stock backend, which returns a host path instead.
    const mounts = buildMounts(join(root, 'workspace'), { spillRoot: root })
    const mapped = mapPath(ref.locator, mounts)
    assert.equal(mapped.host, join(root, ref.locator.slice('/spill/'.length)))
    assert.equal(readFileSync(mapped.host, 'utf8'), '完整输出\n')
  })
})

test('an artifact is private, and its name is one safe segment', async () => {
  await withRoot(async ({ root, request }) => {
    const store = await storeFor(root)
    const ref = await store.saveText(request({ suggestedName: '../../etc/passwd' }))
    const relative = ref.locator.slice('/spill/'.length)
    const segments = relative.split('/')

    assert.equal(segments.length, 2, `session directory plus one file: ${relative}`)
    assert.ok(segments.every(segment => segment !== '.' && segment !== '..'), 'no segment traverses')
    // `.` is kept literal and `/` is escaped, so the name stays one segment
    // inside the session directory.
    assert.equal(segments[1].slice(13), '..~002F..~002Fetc~002Fpasswd')

    const file = join(root, relative)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(join(root, segments[0])).mode & 0o777, 0o700)
  })
})

test('a session directory groups its artifacts, and repeated saves do not collide', async () => {
  await withRoot(async ({ root, request }) => {
    const store = await storeFor(root)
    const first = await store.saveText(request())
    const second = await store.saveText(request({ suggestedName: 'bash.txt' }))

    assert.notEqual(first.locator, second.locator)
    const directory = sessionDirectoryName('sess-1')
    assert.equal(first.locator.slice('/spill/'.length, '/spill/'.length + directory.length), directory)
    // A different session never lands in another session's directory.
    const other = await store.saveText(request({ owner: { sessionId: 'sess-2' } }))
    assert.ok(other.locator.startsWith(`/spill/${sessionDirectoryName('sess-2')}/`))
  })
})

test('a storage failure rejects rather than reporting a locator', async () => {
  await withRoot(async ({ root, request }) => {
    const store = await storeFor(root)
    // A file where the session directory belongs: mkdir cannot succeed.
    const blocked = join(root, sessionDirectoryName('sess-blocked'))
    writeFileSync(blocked, 'not a directory')
    await assert.rejects(store.saveText(request({ owner: { sessionId: 'sess-blocked' } })), error => {
      assert.ok(['EEXIST', 'ENOTDIR'].includes(error.code), `unexpected code ${error.code}`)
      return true
    })
  })
})

test('the activation sweep reclaims aged artifacts and prunes what it emptied', async () => {
  await withRoot(async ({ root, request }) => {
    const directory = join(root, sessionDirectoryName('sess-1'))
    const emptied = join(root, sessionDirectoryName('sess-gone'))
    mkdirSync(directory, { recursive: true })
    mkdirSync(emptied, { recursive: true })
    writeAged(join(directory, 'old.txt'), 'stale', 40)
    writeAged(join(directory, 'fresh.txt'), 'recent', 1)
    writeAged(join(emptied, 'old.txt'), 'stale', 40)
    // Entries the sweep must leave alone: a symlink, and something that is not a
    // session directory.
    symlinkSync('/etc/passwd', join(directory, 'link'))
    mkdirSync(join(root, 'unrelated'))

    const store = await storeFor(root, { cleanupPeriodDays: 30 })
    await store.cleanup

    assert.equal(lstatSync(join(directory, 'old.txt'), { throwIfNoEntry: false }), undefined, 'old file reclaimed')
    assert.equal(readFileSync(join(directory, 'fresh.txt'), 'utf8'), 'recent')
    assert.ok(lstatSync(join(directory, 'link')).isSymbolicLink(), 'symlink left alone')
    assert.equal(lstatSync(emptied, { throwIfNoEntry: false }), undefined, 'emptied session directory pruned')
    assert.ok(lstatSync(directory).isDirectory(), 'a session directory with fresh artifacts survives')
    assert.ok(lstatSync(join(root, 'unrelated')).isDirectory())
    assert.equal((await store.saveText(request())).locator.startsWith('/spill/'), true)
  })
})

test('a missing root is not an error, and cleanupPeriodDays 0 skips the sweep', async () => {
  await withRoot(async ({ root, request }) => {
    const directory = join(root, sessionDirectoryName('sess-1'))
    mkdirSync(directory, { recursive: true })
    writeAged(join(directory, 'old.txt'), 'stale', 40)

    const store = await storeFor(root)
    assert.equal(store.cleanup, undefined, 'no sweep scheduled')
    assert.equal(readFileSync(join(directory, 'old.txt'), 'utf8'), 'stale')

    // An absent root is created on demand by the first save.
    const absent = await storeFor(join(root, 'not-created-yet'))
    const ref = await absent.saveText(request())
    assert.equal(readFileSync(join(root, 'not-created-yet', ref.locator.slice('/spill/'.length)), 'utf8'), 'the full output\n')
  })
})

test('encodeSegment keeps the safe set literal and escapes everything else', () => {
  assert.equal(encodeSegment('bash.txt'), 'bash.txt')
  assert.equal(encodeSegment('a-B_9.z'), 'a-B_9.z')
  assert.equal(encodeSegment(''), '~')
  assert.equal(encodeSegment('/'), '~002F')
  assert.equal(encodeSegment('~'), '~007E')
  assert.equal(encodeSegment('a b'), 'a~0020b')
  // Injective: a literal `~002F` cannot be confused with an escaped `/`.
  assert.notEqual(encodeSegment('~002F'), encodeSegment('/'))
})

test('the mount table resolves the spill root, and the locator needs no host path', () => {
  const workspace = join(tmpdir(), 'bwrap-spill-mount-ws')
  const mounts = buildMounts(workspace, { spillRoot: '/var/lib/spill' })
  assert.deepEqual(mapPath('/spill/session-abc/def.txt', mounts), {
    host: '/var/lib/spill/session-abc/def.txt',
    virtual: '/spill/session-abc/def.txt',
  })
  assert.deepEqual(mapPath('/spill', mounts), { host: '/var/lib/spill', virtual: '/spill' })
})

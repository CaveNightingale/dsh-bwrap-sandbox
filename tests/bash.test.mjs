import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { PathDeniedError, VIRTUAL_SPILL, VIRTUAL_WORKSPACE } from '../lib/paths.js'
import { withWorkdirArgv, workdirArgument } from '../lib/bash.js'

/** A mount table with the workspace, the stores, and `/spill`. */
function mounts() {
  const root = mkdtempSync(join(tmpdir(), 'bwrap-bash-'))
  const workspace = join(root, 'ws')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  return {
    root,
    workspace,
    mounts: [
      { host: workspace, virtual: VIRTUAL_WORKSPACE },
      { host: join(root, 'sessions'), virtual: '/sessions' },
      { host: join(root, 'spill'), virtual: VIRTUAL_SPILL },
    ],
  }
}

test('the requested directory maps through the mount table', () => {
  const fixture = mounts()
  try {
    // A host path, which is what the tool layer resolves a relative workdir to.
    assert.equal(workdirArgument(join(fixture.workspace, 'src'), fixture.mounts), '/workspace/src')
    assert.equal(workdirArgument(fixture.workspace, fixture.mounts), '/workspace')
    // The virtual spelling, which is how the model names every other path.
    assert.equal(workdirArgument('/workspace/src', fixture.mounts), '/workspace/src')
    assert.equal(workdirArgument(VIRTUAL_SPILL, fixture.mounts), VIRTUAL_SPILL)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a directory no mount covers is refused, and so is the virtual root', () => {
  const fixture = mounts()
  try {
    for (const workdir of ['/etc', join(fixture.root, 'outside'), '/']) {
      assert.throws(() => workdirArgument(workdir, fixture.mounts), PathDeniedError, `${workdir} must be refused`)
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('the profile\'s own --chdir is replaced, never duplicated', () => {
  const argv = ['bwrap', '--ro-bind', '/usr', '/usr', '--bind', '/ws', '/workspace', '--chdir', '/workspace', '--dev', '/dev', '--', 'bash', '-c', 'pwd']
  const amended = withWorkdirArgv(argv, '/workspace/src')
  // Bubblewrap accepts a second `--chdir` but warns on stderr, and the provider
  // treats any `bwrap: ` line as a runner failure — so a duplicate would mark
  // every failing command as a broken runner.
  assert.equal(amended.filter(token => token === '--chdir').length, 1)
  assert.equal(amended[amended.indexOf('--chdir') + 1], '/workspace/src')
  assert.deepEqual(amended.slice(0, 2), ['bwrap', '--ro-bind'], 'the rest of the profile is untouched')
  assert.deepEqual(amended.slice(-4), ['--', 'bash', '-c', 'pwd'], 'the caller\'s argv is untouched')
})

test('a profile without --chdir gets one before the separator', () => {
  const amended = withWorkdirArgv(['bwrap', '--dev', '/dev', '--', 'bash', '-c', 'pwd'], '/workspace/src')
  assert.deepEqual(amended, ['bwrap', '--dev', '/dev', '--chdir', '/workspace/src', '--', 'bash', '-c', 'pwd'])
})

test('argv from another runner is left alone', () => {
  // A deployment that swapped ctx.sandbox: an option this runner may not accept
  // must not be added to its argv.
  for (const argv of [
    ['sandbox-exec', '-p', '(version 1)', '--', 'bash', '-c', 'pwd'],
    ['bwrap', '--dev', '/dev'],
    [],
  ]) {
    assert.deepEqual(withWorkdirArgv(argv, '/workspace/src'), argv)
  }
})

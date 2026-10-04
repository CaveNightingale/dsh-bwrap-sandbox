import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const SCRIPT = new URL('../scripts/inspect-session-skills.mjs', import.meta.url)

/**
 * Build the smallest deployment the probe can reproduce: a workspace holding a
 * project skill, and the user-level roots beside it.
 * @param body - receives the paths and a runner for the probe.
 */
function withDeployment(body) {
  const root = mkdtempSync(join(tmpdir(), 'bwrap-probe-'))
  const workspace = join(root, 'ws')
  const dsh = join(root, 'dsh')
  const agents = join(root, 'agents')
  mkdirSync(join(workspace, '.agents', 'skills', 'proj-skill'), { recursive: true })
  writeFileSync(join(workspace, '.agents', 'skills', 'proj-skill', 'SKILL.md'), '---\nname: proj-skill\ndescription: project skill\n---\nbody\n')
  mkdirSync(join(dsh, 'skills', 'user-skill'), { recursive: true })
  writeFileSync(join(dsh, 'skills', 'user-skill', 'SKILL.md'), '---\nname: user-skill\ndescription: user skill\n---\nbody\n')
  mkdirSync(agents, { recursive: true })
  /** Run the probe for one session cwd. */
  const run = (cwd) => spawnSync(process.execPath, [
    SCRIPT.pathname,
    '--cwd', cwd,
    '--workspace', workspace,
    '--dsh-home', dsh,
    '--agents-home', agents,
  ], { encoding: 'utf8' })
  try {
    body({ root, workspace, run })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the probe runs the real loader for the session cwd it is given', () => {
  withDeployment(({ workspace, run }) => {
    const result = run('/workspace')
    assert.equal(result.status, 0, result.stderr)
    // The catalog comes from the real registry over the real backend.
    assert.match(result.stdout, /catalog {6}: 2 skill\(s\)/)
    assert.match(result.stdout, /proj-skill\s+project-agents\s+model\s+\/workspace\/\.agents\/skills\/proj-skill\/SKILL\.md/)
    assert.match(result.stdout, /user-skill\s+user-dsh/)
    // The project walk ends at the sandbox root, and nothing else is refused.
    assert.match(result.stdout, /asked of ctx\.fs, 3 refused/)
    assert.match(result.stdout, /REFUSED resolve \/\.git {2}-> {2}FS_NOT_FOUND/)
  })
})

test('the probe shows a host cwd losing the project roots', () => {
  withDeployment(({ workspace, run }) => {
    const result = run(workspace)
    assert.equal(result.status, 0, result.stderr)
    // Only the mounted user-level root survives; the project root is asked for
    // under its host spelling and refused, which the loader can only read as
    // absence.
    assert.match(result.stdout, /catalog {6}: 1 skill\(s\)/)
    // The smoking gun: the project root was asked for under its host spelling and
    // refused, and the workspace skill appears nowhere in the catalogue.
    assert.match(result.stdout, new RegExp(`REFUSED resolve ${workspace}/\\.agents/skills {2}-> {2}FS_NOT_FOUND`))
    assert.doesNotMatch(result.stdout, /proj-skill\s+project-agents/)
  })
})

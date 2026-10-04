import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { loadBaselineInstructions } from '@deepseek-ai/dsh-agent-instructions'
import { WorkspaceFileSystem } from '../lib/fs.js'

/** The workspace's name inside the sandbox, which is what a session cwd holds. */
const VIRTUAL_WORKSPACE = '/workspace'

/**
 * Build the host shape a sandboxed session sees — a workspace under a home
 * directory that is masked inside the sandbox, with `$DSH_HOME` beside it — and
 * run `body` against the real instruction loader and the real backend.
 *
 * This exercises the consumer whose project-root probe used to abort: discovery
 * walks up from the session cwd asking whether `<dir>/.git` exists, and every
 * ancestor of the workspace is outside the mount table.
 *
 * @param body - receives the paths and a backend bound to the workspace.
 */
async function withSession(body) {
  const root = mkdtempSync(join(tmpdir(), 'bwrap-instructions-'))
  const home = join(root, 'home', 'deepseek')
  const dshHome = join(home, '.dsh')
  const workspace = join(home, 'proj')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  writeFileSync(join(workspace, 'AGENTS.md'), 'workspace rules\n')
  // An ancestor project: its marker is the probe that used to fail, and its
  // instructions must never load.
  mkdirSync(join(home, '.git'), { recursive: true })
  writeFileSync(join(home, 'AGENTS.md'), 'ancestor rules must not load\n')

  const context = new Context()
  context.provide('sandboxPolicy', { defaultMode: 'workspace-write' })
  const backend = new WorkspaceFileSystem(context, {
    cwd: workspace,
    diffBasisMaxBytes: 10 * 1024 * 1024,
    sessionsRoot: '',
    attachmentsRoot: '',
    spillRoot: '',
    agentsHome: join(home, '.agents'),
    skillsRoot: join(dshHome, 'skills'),
    userInstructionsFile: join(dshHome, 'AGENTS.md'),
    additionalReadOnlyRoots: [],
  })
  try {
    await body({ root, home, dshHome, workspace, backend })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('project-root discovery stays inside the workspace', async () => {
  await withSession(async ({ backend }) => {
    const rendered = await loadBaselineInstructions({ cwd: VIRTUAL_WORKSPACE, dshHome: '/', maxBytes: 65536 }, backend)
    assert.match(rendered.text, /workspace rules/)
    // The ancestor has a `.git` and its own AGENTS.md; neither is reachable, so
    // the walk ends at the workspace instead of crossing into it.
    assert.doesNotMatch(rendered.text, /ancestor rules/)
  })
})

test('the user-global instruction file loads through its virtual mount', async () => {
  await withSession(async ({ dshHome, backend }) => {
    writeFileSync(join(dshHome, 'AGENTS.md'), 'user-global rules\n')
    const rendered = await loadBaselineInstructions({ cwd: VIRTUAL_WORKSPACE, dshHome: '/', maxBytes: 65536 }, backend)
    assert.match(rendered.text, /user-global rules/)
    assert.match(rendered.text, /workspace rules/)
    assert.match(rendered.text, /Instructions from: \$DSH_HOME\/AGENTS\.md/)
  })
})

test('an absent user-global instruction file is not an error', async () => {
  await withSession(async ({ backend }) => {
    const rendered = await loadBaselineInstructions({ cwd: VIRTUAL_WORKSPACE, dshHome: '/', maxBytes: 65536 }, backend)
    assert.match(rendered.text, /workspace rules/)
  })
})

test('the skill roots the loader reads resolve through the mount table', async () => {
  await withSession(async ({ home, dshHome, backend }) => {
    const userSkill = join(home, '.agents', 'skills', 'demo', 'SKILL.md')
    const localSkill = join(dshHome, 'skills', 'local', 'SKILL.md')
    mkdirSync(join(home, '.agents', 'skills', 'demo'), { recursive: true })
    writeFileSync(userSkill, '---\nname: demo\n---\nbody\n')
    mkdirSync(join(dshHome, 'skills', 'local'), { recursive: true })
    writeFileSync(localSkill, '---\nname: local\n---\nbody\n')

    // `skill-filesystem` is configured with `dshHome: /` and
    // `agentsHome: /agents`, so it joins and lists namespace spellings and the
    // children it reads back are namespace spellings too.
    assert.equal((await backend.resolve('/agents/skills/demo/SKILL.md')).targetKey, userSkill)
    assert.equal((await backend.resolve('/skills/local/SKILL.md')).targetKey, localSkill)
    // The host spellings it used before are not names in this session.
    await assert.rejects(backend.resolve(userSkill), error => {
      assert.equal(error.code, 'FS_NOT_FOUND')
      return true
    })
  })
})

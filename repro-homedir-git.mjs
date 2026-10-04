import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceFileSystem } from '/home/billy/Projects/dsh-bwrap-sandbox/lib/fs.js'

const root = mkdtempSync(join(tmpdir(), 'repro-home-'))
const home = join(root, 'home', 'deepseek')
const project = join(home, 'proj')
mkdirSync(join(project, 'src'), { recursive: true })
writeFileSync(join(project, 'AGENTS.md'), '# project instructions\n')
// No .git anywhere: the workspace is not a repository root.
console.log('workspace  :', project)
console.log('walk probes:', join(project, '.git'), '->', join(home, '.git'), '->', join(root, 'home', '.git'), '-> /.git')

const ctx = new Context()
ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write' })
const backend = new WorkspaceFileSystem(ctx, {
  cwd: project,
  diffBasisMaxBytes: 10 * 1024 * 1024,
  sessionsRoot: '',
  attachmentsRoot: '',
  spillRoot: '',
  additionalReadOnlyRoots: [],
})

for (const probe of [join(project, '.git'), join(home, '.git')]) {
  try {
    const target = await backend.resolve(probe)
    console.log('resolve', probe, '=>', target.displayPath)
  } catch (error) {
    console.log('resolve', probe, '=> THREW', error.code, '|', error.message)
  }
}

const { loadBaselineInstructions } = await import(
  '/home/billy/Projects/deepseek-harness/packages/context/agent-instructions/lib/index.js'
)
// Log every path the walker asks about, in order.
const real = backend.resolve.bind(backend)
backend.resolve = async (path, opts) => {
  const label = String(path).startsWith(project) ? 'inside workspace' : 'ABOVE workspace'
  console.log(`  probe [${label}] ${path}`)
  return await real(path, opts)
}
try {
  const rendered = await loadBaselineInstructions(
    { cwd: project, dshHome: join(home, '.dsh'), maxBytes: 65536 },
    backend,
  )
  console.log('loadBaselineInstructions => OK, rendered =', rendered !== undefined)
} catch (error) {
  console.log('loadBaselineInstructions => THREW', error.constructor.name, '|', error.message)
}

rmSync(root, { recursive: true, force: true })

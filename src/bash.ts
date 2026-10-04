/**
 * `ctx.shell` executor for the bwrap confinement.
 *
 * `bash-sandbox` confines argv correctly but never sees where the caller asked
 * to start: `confine()` takes argv and policy, and bubblewrap discards the spawn
 * cwd — with no `--chdir` it chdirs to `$HOME`, and to `/` when `$HOME` does not
 * exist inside. So every command ran in `/workspace` whatever the tool's
 * `workdir` argument said, with no error and nothing in the result to notice.
 *
 * The interception point is {@link BwrapBashExecutor.executeArgv}, which the
 * local executor documents as the subclass hook for replacing a boundary's argv
 * and which `execute` reaches through `this`. The override appends one
 * `--chdir` — bubblewrap accepts a second one and the last wins — carrying the
 * workdir mapped into the mount namespace. A workdir that names no mount is
 * refused, matching how the file tools treat the same path, instead of silently
 * running somewhere else.
 *
 * `pwsh` keeps the gap: `pwsh-sandbox` calls `confine()` the same way, and this
 * executor does not cover it.
 *
 * @module dsh-bwrap-sandbox/bash
 */

import { statSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalBashConfig } from '@deepseek-ai/dsh-bash-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import type { ShellExecution, ShellExecSpec } from '@deepseek-ai/dsh-shell'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { assertMountConfig, buildMounts } from './mounts.js'
import type { MountConfig } from './mounts.js'
import { FAKE_ROOT, PathDeniedError, declaredRootFor, mapPath } from './paths.js'
import type { Mount } from './paths.js'

export const name = 'bash-bwrap'

/**
 * The mount fields, resolved and validated here rather than by a schema the
 * loader runs for this row.
 *
 * This executor inherits `LocalBashExecutor`'s config schema, the same choice
 * `SandboxBashExecutor` makes, because schemastery cannot compose it with more
 * fields: `z.intersect` puts its members behind an array index, which breaks the
 * `volatile()` knobs the local executor reads through (`$.0.cwd` is not a fixed
 * object path, and schemastery rejects it), and spreading the schema's dict
 * loses the knob types. The loader validates the knobs through the inherited
 * schema and passes these fields through; this schema resolves them.
 *
 * The cost is that `--dump-config-schema` lists the inherited knobs for this row
 * and not these fields. The README carries the same names for every row.
 */
const mountsSchema = z.object({
  workspace: z.string().default(''),
  sessionsRoot: z.string().default(''),
  attachmentsRoot: z.string().default(''),
  spillRoot: z.string().default(''),
  agentsHome: z.string().default(''),
  skillsRoot: z.string().default(''),
  userInstructionsFile: z.string().default(''),
  additionalReadOnlyRoots: z.array(z.string()).default([]),
  writableRoots: z.array(z.string()).default([]),
})

/** Plugin config: the local executor's knobs, plus the virtual namespace's mounts. */
export type BashConfig = LocalBashConfig & ReturnType<typeof mountsSchema>

/**
 * The virtual path a requested working directory maps to.
 *
 * The caller's `workdir` is an execution-world path: the tool layer resolves a
 * relative one against the session cwd, which `/workspace` is, and a model-named
 * one is refused by the guard when it spells a host path. A session recorded
 * before the namespace existed asks for its own host directory instead, and that
 * maps only when it IS the workspace mount's root — the string the operator wrote
 * into the mount table — so no other host path can start a command.
 *
 * @param workdir - the caller's requested working directory.
 * @param mounts - the mounts in effect for this call.
 * @returns the virtual path to start in.
 * @throws {PathDeniedError} when it names no mount, or is the virtual root.
 */
export function workdirArgument(workdir: string, mounts: readonly Mount[]): string {
  const mapped = mapPath(declaredRootFor(workdir, mounts) ?? workdir, mounts)
  if (mapped.host === FAKE_ROOT) {
    throw new PathDeniedError(workdir, `"${workdir}" is the virtual root, not a directory`)
  }
  return mapped.virtual
}

/**
 * Point the confined argv at `virtualWorkdir`.
 *
 * The profile already carries `--chdir /workspace`, so this REPLACES that value
 * rather than adding a second option. Bubblewrap accepts a repeated `--chdir`
 * and honours the last, but it warns on stderr
 * (`bwrap: Only the last --chdir option will take effect`), and the provider's
 * runner-failure rules match any `bwrap: ` line — so a second option would mark
 * every failing command as a broken runner.
 *
 * The argv is this provider's own, so the profile ends at the first bare `--`:
 * none of its options is a lone `--`, and the caller's command follows it.
 * Anything that does not look like this provider's argv — a deployment that
 * swapped `ctx.sandbox` — is returned untouched.
 *
 * @param argv - the confined argv from `ctx.sandbox.confine()`.
 * @param virtualWorkdir - the virtual directory to start in.
 * @returns the argv that starts there, or `argv` unchanged.
 */
export function withWorkdirArgv(argv: readonly string[], virtualWorkdir: string): readonly string[] {
  if (argv[0] !== 'bwrap') return argv
  const separator = argv.indexOf('--')
  if (separator < 0) return argv
  const existing = argv.indexOf('--chdir')
  if (existing >= 0 && existing < separator - 1) {
    const replaced = [...argv]
    replaced[existing + 1] = virtualWorkdir
    return replaced
  }
  return [...argv.slice(0, separator), '--chdir', virtualWorkdir, ...argv.slice(separator)]
}

/**
 * Registers as `ctx.shell` in place of `bash-sandbox`. Requires the same
 * services — `subprocess`, `sandbox`, and `sandboxPolicy` — and adds nothing but
 * the working directory the stock sandboxed executor cannot place.
 */
export class BwrapBashExecutor extends SandboxBashExecutor {
  // No own `Config`: the inherited local schema validates the knobs, and
  // schemastery cannot compose it with the mount fields (see `mountsSchema`).

  private readonly mountConfig: MountConfig
  /**
   * The host directory the mount table anchors at.
   *
   * The session spelling is virtual, so this row owns the host side: it is where
   * the runner spawns and what the mount table resolves against.
   */
  private readonly workspace: string

  constructor(ctx: Context, config: BashConfig) {
    super(ctx, config)
    // The loader passes these through unvalidated, so resolve them here.
    this.mountConfig = mountsSchema(config)
    this.workspace = (config.workspace as string) || process.cwd()
    // Fail at load, not as an unreachable directory later.
    assertMountConfig(this.mountConfig)
  }

  /**
   * Amend the confined argv with the caller's working directory.
   *
   * `execute` reaches this method through `this`, so the override sits between
   * `ctx.sandbox.confine()` and the subprocess spawn with the spec in hand. A
   * literal argv — the `danger-full-access` path, which delegates to the local
   * executor — carries no profile to amend and is passed through.
   *
   * The spawn itself is re-anchored at the workspace root on a copy of the spec:
   * the caller's `workdir` is not always a host path (the model may name
   * `/workspace/src`, which is what every other tool accepts), and a spawn whose
   * cwd does not exist on the host fails before the runner starts. Bubblewrap
   * then places the child through `--chdir`, so the spawn's own directory has no
   * further effect. The harness keeps its own `spec`, so runner-failure
   * diagnostics still report the directory the caller asked for.
   *
   * @param spec - the resolved execution settings.
   * @param argvOrPrepare - exact argv, or the confinement callback to wrap.
   * @param onStarted - installs provider facts before the handle can settle.
   * @returns the live execution handle.
   */
  protected override async executeArgv(
    spec: ShellExecSpec,
    argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>),
    onStarted?: (process: ShellExecution) => void,
  ): Promise<ShellExecution> {
    if (typeof argvOrPrepare !== 'function') return super.executeArgv(spec, argvOrPrepare, onStarted)
    const start = this.startIn(spec)
    return super.executeArgv({ ...spec, workdir: start.anchor }, async (signal) => {
      const argv = await argvOrPrepare(signal)
      return withWorkdirArgv(argv, start.virtual)
    }, onStarted)
  }

  /**
   * Resolve where the confined command starts: the virtual directory to hand
   * bubblewrap, and the host directory the runner itself is spawned in.
   * @param spec - the resolved execution settings, carrying the policy and the
   *   requested working directory.
   * @returns the virtual directory and the host spawn anchor.
   * @throws when the request carries no policy, or the working directory names
   *   no mount.
   */
  private startIn(spec: ShellExecSpec): { virtual: string; anchor: string } {
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy | undefined
    if (policy === undefined) {
      throw new Error('bash-bwrap: the execution spec carries no sandbox policy, so the working directory cannot be placed')
    }
    const mounts = buildMounts(this.workspace, this.mountConfig)
    let virtual: string
    try {
      virtual = workdirArgument(spec.workdir, mounts)
    } catch (error) {
      if (!(error instanceof PathDeniedError)) throw error
      throw new Error(`bash: cannot start in "${spec.workdir}": ${error.message}`)
    }
    // A directory the sandbox does not have would surface as bubblewrap failing
    // to build the profile, which the provider reports as an unusable runner.
    // Name the real problem instead.
    const complaint = startComplaint(spec.workdir, mounts)
    if (complaint !== undefined) throw new Error(`bash: cannot start in "${spec.workdir}": ${complaint}`)
    return { virtual, anchor: this.workspace }
  }
}

/**
 * Why the requested directory cannot be started in, or `undefined` when it can.
 *
 * @param workdir - the caller's requested working directory.
 * @param mounts - the mounts in effect for this call.
 * @returns the complaint, phrased to continue "cannot start in ...".
 */
function startComplaint(workdir: string, mounts: readonly Mount[]): string | undefined {
  const mapped = mapPath(declaredRootFor(workdir, mounts) ?? workdir, mounts)
  if (mapped.host === FAKE_ROOT) return 'it is the virtual root, not a directory'
  const stats = statSync(mapped.host, { throwIfNoEntry: false })
  if (stats === undefined) return 'it does not exist'
  return stats.isDirectory() ? undefined : `it is not a directory (${mapped.virtual})`
}

export default BwrapBashExecutor

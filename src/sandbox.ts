/**
 * bwrap-only `ctx.sandbox` provider.
 *
 * Every `ctx.sandbox.confine()` consumer — `bash`, `pwsh`, the PTY shell, and
 * PTC `run_code` — reaches this provider, so one mount profile bounds all four.
 * The profile masks every home directory, binds the session workspace at
 * `/workspace`, and exposes the session, attachment, and spill stores plus the
 * user-level agents home, skill root, and instruction file read-only at stable
 * virtual paths, so nothing a confined process can print names a host path and
 * the same names resolve for the file tools.
 *
 * Linux only and fail-closed: bubblewrap is the sole backend, and a host
 * without a usable `bwrap` refuses the command rather than running it
 * unconfined.
 *
 * @module dsh-bwrap-sandbox/sandbox
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { sandboxDenialMarker, SandboxProvider, SandboxUnavailableError, canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defaultAgentsHome, USER_INSTRUCTIONS_FILE } from './mounts.js'
import {
  trimSeparator,
  VIRTUAL_AGENTS,
  VIRTUAL_ATTACHMENTS,
  VIRTUAL_SESSIONS,
  VIRTUAL_SKILLS,
  VIRTUAL_SPILL,
  VIRTUAL_USER_INSTRUCTIONS,
  VIRTUAL_WORKSPACE,
} from './paths.js'

export const name = 'bwrap-sandbox'

/** Plugin config: the mount profile, changeable from cordis.yml. */
export interface Config {
  /**
   * Absolute host directories bound read-only under their own path. These are
   * the system roots a shell needs; omitting one makes every command that
   * touches it fail, so keep the list complete for the host distribution.
   */
  systemReadOnlyRoots?: string[]
  /**
   * Absolute host directories replaced by an empty tmpfs inside the sandbox.
   * This is what removes home-directory access; the covered roots are writable
   * but ephemeral and hold no host data.
   */
  maskedRoots?: string[]
  /** Host session-log directory exposed read-only at `/sessions`; empty resolves `$DSH_HOME/sessions`. */
  sessionsRoot?: string
  /** Host attachment store exposed read-only at `/attachments`; empty resolves `$DSH_HOME/attachments`. */
  attachmentsRoot?: string
  /**
   * Host spill directory exposed read-only at `/spill`; empty resolves
   * `$DSH_HOME/spill`. Must match the `spillRoot` of the `spill-bwrap` and
   * `fs-bwrap` rows, which are configured separately.
   */
  spillRoot?: string
  /**
   * Host user-level agents home exposed read-only at `/agents`; empty resolves
   * `$DSH_AGENTS_HOME` or `~/.agents`. Must match the `agentsHome` of the
   * `fs-bwrap` and `guard-bwrap` rows, which are configured separately.
   */
  agentsHome?: string
  /** Host user-level DSH skill root exposed read-only at `/skills`; empty resolves `$DSH_HOME/skills`. */
  skillsRoot?: string
  /**
   * Host user-global instruction file exposed read-only at `/AGENTS.md`; empty
   * resolves `$DSH_HOME/AGENTS.md`. The file usually does not exist, which is
   * normal: the mount is skipped and the tool side reports it as absent.
   */
  userInstructionsFile?: string
  /** Mount a private writable `/tmp` (default true). */
  privateTmp?: boolean
  /**
   * Virtual mounts bound writable instead of read-only: a confined process may
   * write inside them, which is what makes agent-authored skills possible.
   *
   * Must list the same mounts as the `fs-bwrap` row, which admits the write; a
   * mount writable here but read-only there fails as a denial. `read-only` mode
   * is unaffected and still denies every mutation.
   */
  writableRoots?: string[]
  /**
   * Environment names the confined process must not see, because their values
   * name host paths. Restore a name to a child by listing it in the shell tool's
   * own environment instead.
   */
  dropEnv?: string[]
}

export const Config: z<Config> = z.object({
  systemReadOnlyRoots: z.array(z.string()).default(['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/opt']),
  maskedRoots: z.array(z.string()).default(['/home', '/root']),
  sessionsRoot: z.string().default(''),
  attachmentsRoot: z.string().default(''),
  spillRoot: z.string().default(''),
  agentsHome: z.string().default(''),
  skillsRoot: z.string().default(''),
  userInstructionsFile: z.string().default(''),
  privateTmp: z.boolean().default(true),
  writableRoots: z.array(z.string()).default([]),
  dropEnv: z.array(z.string()).default(['DSH_HOME', 'DSH_PROFILE_DIR']),
})

/** The denial dialect bubblewrap's read-only binds produce (EROFS text). */
const DENIAL_SIGNATURES = ['read-only file system'] as const

/** Bubblewrap's own fatal-diagnostic prefix, so runner failures stay distinguishable. */
const RUNNER_FAILURE_RULES = [{ fatalSignatures: ['bwrap: '] }] as const

/**
 * Bind one host source read-only at its virtual name, when the source exists.
 *
 * A missing source makes bubblewrap refuse the entire profile (`bwrap: Can't
 * find source path`), which would take the workspace down with it: a fresh
 * `$DSH_HOME`, an absent `~/.agents`, and a user who never wrote a user-global
 * `AGENTS.md` are all normal states. The tool side reports the same absence as
 * `FS_NOT_FOUND`, so both views agree the store is not there.
 *
 * @param args - the profile argv being built.
 * @param source - the absolute host directory or file; empty skips the bind.
 * @param virtual - the virtual path to expose it at.
 * @param writable - bind read-write instead of read-only.
 */
function bindIfPresent(args: string[], source: string, virtual: string, writable: boolean): void {
  if (source.length === 0 || !existsSync(source)) return
  args.push(writable ? '--bind' : '--ro-bind', source, virtual)
}

/** Fully resolved configuration after `apply` defaulting. */
interface ResolvedConfig {
  systemReadOnlyRoots: readonly string[]
  maskedRoots: readonly string[]
  sessionsRoot: string
  attachmentsRoot: string
  spillRoot: string
  agentsHome: string
  skillsRoot: string
  userInstructionsFile: string
  privateTmp: boolean
  writableRoots: readonly string[]
  dropEnv: readonly string[]
}

/**
 * Build the bubblewrap profile arguments for one per-call policy.
 *
 * Order is load-bearing. Bubblewrap applies mounts in argv order and a later
 * mount replaces an earlier one at the same path, so the masking tmpfs entries
 * must follow the system binds, and the workspace bind must follow the masking
 * of its own ancestors. The read-only stores are bound from host paths that may
 * live under a masked root: bubblewrap resolves a bind SOURCE in the host
 * namespace, so those mounts still work and reveal nothing.
 *
 * `/sessions`, `/attachments`, `/spill`, `/agents`, `/skills`, and `/AGENTS.md`
 * are read-only on purpose: the harness writes them from outside the sandbox, and
 * a confined process needs to read spilled results, skills, and instructions,
 * never to forge or delete them. Each bind is skipped when its host source is
 * absent, which is the same state the tool side reports as `FS_NOT_FOUND`.
 *
 * @param policy - the per-call file-effect policy; the workspace root is canonical.
 * @param config - the resolved mount profile.
 * @returns the profile arguments, before the trailing separator and command argv.
 */
export function profileArgs(policy: SandboxPolicy, config: ResolvedConfig): string[] {
  const workspaceWritable = policy.mode === 'workspace-write'
  const args: string[] = []

  for (const root of config.systemReadOnlyRoots) args.push('--ro-bind', root, root)

  for (const root of config.maskedRoots) args.push('--tmpfs', root)

  const writable = new Set(config.writableRoots)
  bindIfPresent(args, config.sessionsRoot, VIRTUAL_SESSIONS, writable.has(VIRTUAL_SESSIONS))
  bindIfPresent(args, config.attachmentsRoot, VIRTUAL_ATTACHMENTS, writable.has(VIRTUAL_ATTACHMENTS))
  bindIfPresent(args, config.spillRoot, VIRTUAL_SPILL, writable.has(VIRTUAL_SPILL))
  bindIfPresent(args, config.agentsHome, VIRTUAL_AGENTS, writable.has(VIRTUAL_AGENTS))
  bindIfPresent(args, config.skillsRoot, VIRTUAL_SKILLS, writable.has(VIRTUAL_SKILLS))
  bindIfPresent(
    args,
    config.userInstructionsFile,
    VIRTUAL_USER_INSTRUCTIONS,
    writable.has(VIRTUAL_USER_INSTRUCTIONS),
  )

  if (config.privateTmp) args.push('--tmpfs', '/tmp')

  args.push(workspaceWritable ? '--bind' : '--ro-bind', policy.workspaceRoot, VIRTUAL_WORKSPACE)

  // The caller spawns with its own cwd — the host workspace path — applied
  // before bubblewrap builds the namespace. `--chdir` re-anchors the confined
  // process at the virtual workspace, and HOME follows it so tools that write
  // under `~` stay inside the writable workspace instead of an absent path.
  args.push('--chdir', VIRTUAL_WORKSPACE, '--setenv', 'HOME', VIRTUAL_WORKSPACE)
  for (const name of config.dropEnv) args.push('--unsetenv', name)

  args.push('--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent')
  return args
}

/**
 * Redirect every confined process into a bubblewrap mount profile.
 *
 * Linux only: no platform chain, no fallback. When `bwrap` is missing or cannot
 * build the profile the call fails closed with `SANDBOX_UNAVAILABLE`.
 */
export class BwrapSandboxProvider extends SandboxProvider {
  static Config: z<Config> = Config

  private readonly resolved: ResolvedConfig
  /** Probe verdict, resolved once on the first `confine()`. */
  private usable: boolean | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const sessionsRoot = (config.sessionsRoot as string) || dshHomePath('sessions')
    const attachmentsRoot = (config.attachmentsRoot as string) || dshHomePath('attachments')
    const spillRoot = (config.spillRoot as string) || dshHomePath('spill')
    this.resolved = {
      systemReadOnlyRoots: (config.systemReadOnlyRoots as string[]).map(trimSeparator),
      maskedRoots: (config.maskedRoots as string[]).map(trimSeparator),
      // The stores the model may read through /sessions, /attachments, and /spill.
      sessionsRoot,
      attachmentsRoot,
      spillRoot,
      // The user-level inputs the harness itself reads through `ctx.fs`.
      agentsHome: (config.agentsHome as string) || defaultAgentsHome(),
      skillsRoot: (config.skillsRoot as string) || dshHomePath('skills'),
      userInstructionsFile: (config.userInstructionsFile as string) || dshHomePath(USER_INSTRUCTIONS_FILE),
      privateTmp: config.privateTmp as boolean,
      writableRoots: config.writableRoots as string[],
      dropEnv: config.dropEnv as string[],
    }
  }

  /**
   * Wrap `argv` in the bubblewrap invocation for `policy`.
   * @param argv - the exact argv the caller is about to spawn.
   * @param policy - the per-call file-effect policy.
   * @param signal - cancellation before the profile is built.
   * @returns the enforcing argv plus bubblewrap's enforcement and diagnostic facts.
   * @throws {SandboxUnavailableError} when this is not Linux or `bwrap` cannot build the profile.
   */
  async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    if (process.platform !== 'linux') {
      throw new SandboxUnavailableError(policy.mode, 'dsh-bwrap-sandbox confines with bubblewrap, which exists only on Linux')
    }
    const workspaceRoot = canonicalPath(policy.workspaceRoot)
    const profile = profileArgs({ ...policy, workspaceRoot }, this.resolved)
    if (!this.isUsable(profile)) {
      throw new SandboxUnavailableError(policy.mode, 'bwrap could not build the mount profile on this host')
    }
    return {
      argv: ['bwrap', ...profile, '--', ...argv],
      enforcement: 'full',
      denialSignatures: DENIAL_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE_RULES,
    }
  }

  /**
   * The functional probe: actually build the profile and run `true` under it.
   * A version check would miss a kernel or host that has `bwrap` but refuses
   * the namespace, so restricting a real process is the only honest signal.
   */
  private isUsable(profile: readonly string[]): boolean {
    this.usable ??= spawnSync('bwrap', [...profile, '--', 'true'], { stdio: 'ignore' }).status === 0
    return this.usable
  }
}

export default BwrapSandboxProvider

export { sandboxDenialMarker }

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
import { assertMountConfig, defaultAgentsHome, extraRootName, USER_INSTRUCTIONS_FILE } from './mounts.js'
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
  /**
   * Further host directories bound read-only as `{ <name>: <host directory> }`,
   * the same map `fs-bwrap` and `guard-bwrap` take.
   *
   * The key is the mount point and the value is the host directory behind it, so
   * a nested host directory such as `/home/deepseek/my_files` is bound at a name
   * of the operator's choosing (`my_files:` → `/my_files`) instead of under its
   * host path. The key is one top-level segment, with or without its leading
   * slash. Must match the other rows' map, or the tools and the sandbox disagree
   * about the same directory.
   */
  additionalReadOnlyRoots?: Record<string, string>
  /** Host session-log directory exposed read-only at `/sessions`; empty resolves `$DSH_HOME/sessions`. */
  sessionsRoot?: string
  /** Host attachment store exposed read-only at `/attachments`; empty resolves `$DSH_HOME/attachments`. */
  attachmentsRoot?: string
  /**
   * Host workspace directory bound at `/workspace`; empty resolves the process
   * working directory.
   *
   * The harness spells the workspace the way the execution world does, so the
   * policy this row receives names `/workspace`. The host side is this row's own
   * fact, and it is what the bind source and the mount table resolve against.
   */
  workspace?: string
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
  systemReadOnlyRoots: z.array(z.string()).default(['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/opt']),  maskedRoots: z.array(z.string()).default(['/home', '/root']),
  workspace: z.string().default(''),
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
  /** Further read-only binds, resolved to a mount point and its host directory. */
  additionalReadOnlyRoots: readonly { at: string; host: string }[]
  /** Canonical host directory bound at {@link VIRTUAL_WORKSPACE}. */
  workspace: string
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
 * never to forge or delete them. Every bind — the system roots included — is
 * skipped when its host source is absent, because a distribution that has no
 * `/opt` or no `/sbin` would otherwise make bubblewrap refuse the whole profile;
 * the tool side reports the same absence as `FS_NOT_FOUND`.
 *
 * @param policy - the per-call file-effect policy; the workspace root is canonical.
 * @param config - the resolved mount profile.
 * @returns the profile arguments, before the trailing separator and command argv.
 */
export function profileArgs(policy: SandboxPolicy, config: ResolvedConfig): string[] {
  const workspaceWritable = policy.mode === 'workspace-write'
  const args: string[] = []

  for (const root of config.systemReadOnlyRoots) bindIfPresent(args, root, root, false)

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

  for (const extra of config.additionalReadOnlyRoots) {
    bindIfPresent(args, extra.host, extra.at, writable.has(extra.at))
  }

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
  private usability: { ok: boolean; reason: string } | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Fail at load for a nested mount name, a non-absolute host directory, or a
    // name two mounts claim — the same rules the tool-side rows enforce.
    assertMountConfig(config)
    const sessionsRoot = (config.sessionsRoot as string) || dshHomePath('sessions')
    const attachmentsRoot = (config.attachmentsRoot as string) || dshHomePath('attachments')
    const spillRoot = (config.spillRoot as string) || dshHomePath('spill')
    this.resolved = {
      systemReadOnlyRoots: (config.systemReadOnlyRoots as string[]).map(trimSeparator),
      maskedRoots: (config.maskedRoots as string[]).map(trimSeparator),
      additionalReadOnlyRoots: Object.entries((config.additionalReadOnlyRoots as Record<string, string>) ?? {})
        .map(([name, host]) => ({ at: extraRootName(name), host: trimSeparator(host) })),
      workspace: canonicalPath((config.workspace as string) || process.cwd()),
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
   * The host directory that the policy's workspace root names.
   *
   * The policy spells paths the way the execution world does — its own contract
   * says so — so an agent session reports `/workspace`, and the host side is this
   * row's configured directory. A session recorded before the namespace existed
   * reports its own host directory instead, which is honored only when it IS that
   * configured directory; any other root would confine against the wrong
   * directory, so it fails closed.
   *
   * @param policy - the per-call file-effect policy.
   * @returns the canonical host workspace directory.
   * @throws {SandboxUnavailableError} when the policy names a different root.
   */
  private hostWorkspaceFor(policy: SandboxPolicy): string {
    const root = trimSeparator(policy.workspaceRoot)
    if (root === VIRTUAL_WORKSPACE || root === trimSeparator(this.resolved.workspace)) {
      return this.resolved.workspace
    }
    throw new SandboxUnavailableError(
      policy.mode,
      `the sandbox policy names workspace root ${JSON.stringify(policy.workspaceRoot)}, which is neither ${JSON.stringify(VIRTUAL_WORKSPACE)} nor this row's configured workspace directory`,
    )
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
    const workspaceRoot = this.hostWorkspaceFor(policy)
    const profile = profileArgs({ ...policy, workspaceRoot }, this.resolved)
    const usability = this.usabilityOf(profile)
    if (!usability.ok) {
      throw new SandboxUnavailableError(
        policy.mode,
        `bwrap could not build the mount profile on this host: ${usability.reason}`,
      )
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
   *
   * The verdict includes bubblewrap's own first diagnostic line, because that
   * line is almost always the answer: a bind source that does not exist (the
   * session workspace, a store), a namespace the host refuses, or a `true` it
   * cannot execute because the profile omits the shell's own directory. The
   * caller sees only this detail, so discarding it leaves an unrunnable host
   * indistinguishable from a malformed profile.
   *
   * @param profile - the profile arguments to test.
   * @returns the cached verdict, with the reason when it is negative.
   */
  private usabilityOf(profile: readonly string[]): { ok: boolean; reason: string } {
    this.usability ??= this.probe(profile)
    return this.usability
  }

  /**
   * Run the probe once and classify its outcome.
   * @param profile - the profile arguments to test.
   * @returns `ok` with an empty reason, or the reported reason.
   */
  private probe(profile: readonly string[]): { ok: boolean; reason: string } {
    const argv = ['bwrap', ...profile, '--', 'true']
    const probe = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
    if (probe.error !== undefined) {
      const code = (probe.error as NodeJS.ErrnoException).code
      return this.refuse(code === 'ENOENT' ? 'bwrap is not installed' : String(probe.error), argv)
    }
    if (probe.status === 0) return { ok: true, reason: '' }
    const diagnostic = (probe.stderr ?? '').trim().split('\n')[0] ?? ''
    return this.refuse(diagnostic === '' ? `bwrap exited with status ${probe.status}` : diagnostic, argv)
  }

  /**
   * Report a failed probe and return the negative verdict.
   *
   * The report goes three places, because each reaches a different reader. The
   * thrown error is a tool result inside the session, so the model and the
   * transcript get it. The logger keeps it structured for tests and for the boot
   * audit. Neither prints: no shipping app installs a console log exporter, and
   * the boot exporter only surfaces on a startup failure — so the operator
   * watching the terminal would see a refused command with no reason at all.
   * Hence the direct stderr write, once per process.
   *
   * @param reason - bubblewrap's own diagnostic, or the spawn failure.
   * @param argv - the exact probe command, for reproduction.
   * @returns the negative verdict carrying `reason`.
   */
  private refuse(reason: string, argv: readonly string[]): { ok: boolean; reason: string } {
    const report = unavailableReport(reason, argv)
    this.ctx.logger.error(report)
    process.stderr.write(`${report}\n`)
    return { ok: false, reason }
  }
}

/**
 * Compose the operator-facing report for a profile bubblewrap cannot build.
 *
 * The command is the part that makes it actionable: it is the exact profile the
 * provider would have run, so the same failure can be reproduced without the
 * harness and its mounts inspected by hand.
 *
 * @param reason - bubblewrap's own diagnostic, or the spawn failure.
 * @param argv - the probe command, without the trailing inner command.
 * @returns the multi-line report.
 */
export function unavailableReport(reason: string, argv: readonly string[]): string {
  return [
    'dsh-bwrap-sandbox: bwrap cannot build the sandbox profile on this host, so confined commands are refused.',
    `  reason: ${reason}`,
    `  reproduce: ${argv.map(quoteForShell).join(' ')}`,
  ].join('\n')
}

/**
 * Quote one argv part so a logged command can be pasted into a shell.
 * @param part - the argument to quote.
 * @returns the argument, quoted only when a shell would read it differently.
 */
function quoteForShell(part: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(part) ? part : `'${part.replaceAll("'", String.raw`'\''`)}'`
}

export default BwrapSandboxProvider

export { sandboxDenialMarker }

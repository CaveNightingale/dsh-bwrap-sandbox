/**
 * Workspace-fenced `ctx.fs` backend.
 *
 * `LocalFileSystem.resolve()` is the single entry every filesystem operation
 * passes through, so one fence there bounds reads as well as mutations — unlike
 * the stock `dsh-fs-sandbox`, which fences mutations only and lets a `read`
 * reach any host path.
 *
 * The fence is {@link mapPath}: a virtual path is walked to a host path, and any
 * segment that leaves the mounts refuses the whole call. Because every host path
 * is built as `<mount host>` plus virtual segments, containment needs no second
 * check — there is nothing to escape *to*, since a symlink is followed in the
 * virtual namespace rather than the host one.
 *
 * A refused name is reported the way the confined process sees it — absent, as
 * `FS_NOT_FOUND` — because that is what the sandbox profile actually produces
 * for it. Callers that probe for a file get the same answer they get from a
 * provider with no fence; callers that need the boundary named read it from the
 * tool guard instead.
 *
 * This is a policy check in trusted code over a model-controlled path, not a
 * kernel boundary; kernel-grade isolation of running code stays
 * `bwrap-sandbox`'s job.
 *
 * @module dsh-bwrap-sandbox/fs
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsPathInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { Config as LocalFileConfig } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { assertMountConfig, buildMounts } from './mounts.js'
import type { MountConfig } from './mounts.js'
import { FAKE_ROOT, PathDeniedError, VIRTUAL_WORKSPACE, declaredRootFor, hostToVirtual, isUnder, isVirtualPath, mapPath, toVirtualPath, trimSeparator } from './paths.js'

export const name = 'fs-bwrap'

/** Plugin config: the local backend's knobs plus the virtual namespace's mounts. */
export interface Config extends LocalFileConfig, MountConfig {}

export const Config: z<Config> = z.intersect([
  LocalFileSystem.Config,
  z.object({
    sessionsRoot: z.string().default(''),
    attachmentsRoot: z.string().default(''),
    spillRoot: z.string().default(''),
    agentsHome: z.string().default(''),
    skillsRoot: z.string().default(''),
    userInstructionsFile: z.string().default(''),
    additionalReadOnlyRoots: z.array(z.string()).default([]),
    writableRoots: z.array(z.string()).default([]),
  }),
])

/**
 * The filesystem backend the model's file tools talk to. Paths resolve inside
 * the session workspace or one of the read-only harness stores, and the
 * `displayPath` the model sees is always the virtual one.
 */
export class WorkspaceFileSystem extends SandboxedFileSystem {
  static inject = ['sandboxPolicy']
  static Config: z<Config> = Config

  private readonly mountConfig: MountConfig

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.mountConfig = {
      sessionsRoot: config.sessionsRoot,
      attachmentsRoot: config.attachmentsRoot,
      spillRoot: config.spillRoot,
      agentsHome: config.agentsHome,
      skillsRoot: config.skillsRoot,
      userInstructionsFile: config.userInstructionsFile,
      additionalReadOnlyRoots: config.additionalReadOnlyRoots,
      writableRoots: config.writableRoots,
    }
    // Fail at load, not as an unreachable directory later.
    assertMountConfig(this.mountConfig)
  }

  /**
   * Map the caller's path into the mount namespace and resolve it there.
   *
   * The mapping is synchronous — it is `lstat`/`readlink` per segment — and the
   * inherited resolution still runs afterwards, so an unmapped-relative path, a
   * new file, and a deepest-existing-ancestor walk all keep their local-backend
   * behavior. What changes is that only a mapped host path reaches it.
   *
   * @param path - the model- or plugin-supplied path.
   * @param opts - the resolution cwd (the session workspace) and cancellation signal.
   * @returns the resolved target with the virtual `displayPath`.
   * @throws {FsError} `FS_NOT_FOUND` when no mount reaches the path.
   */
  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const mounts = this.mounts()
    const virtualPath = toVirtualPath(path, this.anchor(opts?.cwd, mounts))
    const mapped = this.map(path, virtualPath, mounts)
    const target = await super.resolve(mapped.host, opts)
    return { targetKey: target.targetKey, displayPath: mapped.virtual }
  }

  /**
   * Map a raw path the way {@link resolve} does, for the seam's other
   * path-taking entry point.
   *
   * `FsPathInfo` carries a version, a type, and a size and no path, so the value
   * the local backend built from the mapped host path discloses nothing; the
   * caller's own argument is the only spelling in play, and it was already a
   * virtual name to get this far.
   *
   * @param path - the caller-supplied path.
   * @param opts - the resolution cwd and cancellation signal.
   * @param signal - cancellation signal, when the caller passed one separately.
   * @returns the path info, or `undefined` when the path does not exist.
   * @throws {FsError} `FS_NOT_FOUND` when no mount reaches the path.
   */
  override async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    const mounts = this.mounts()
    const virtualPath = toVirtualPath(path, this.anchor(opts?.cwd, mounts))
    const mapped = this.map(path, virtualPath, mounts)
    return super.lstat(mapped.host, opts, signal)
  }

  /**
   * List a directory, reporting each child under the name the namespace uses.
   *
   * The inherited listing resolves every child and reports the host path as that
   * child target's `displayPath`. Consumers put that straight into model-facing
   * text — `str_replace_editor`'s directory view prints one line per entry — so
   * this is the one place where a host spelling would reach the model without an
   * argument naming it. The child's name is `<listed directory>/<basename>`,
   * which is the spelling a caller can pass back to any other method.
   *
   * A child whose resolved target lies outside every mount — a link pointing out
   * of the workspace — is omitted rather than listed with an unresolvable
   * target: the entry's target re-enters this backend for follow-up operations,
   * and one naming a host path would take those operations outside the fence.
   * The confined shell still shows the link; this listing agrees with what the
   * file tools can read.
   *
   * @param target - the directory to list.
   * @param signal - cancellation signal.
   * @returns the children the fence can name, each with a virtual `displayPath`.
   */
  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const entries = await super.listDir(target, signal)
    const mounts = this.mounts()
    const parent = trimSeparator(target.displayPath)
    const listed: FsDirEntry[] = []
    for (const entry of entries) {
      if (hostToVirtual(String(entry.target.targetKey), mounts) === undefined) continue
      listed.push({
        ...entry,
        target: {
          targetKey: entry.target.targetKey,
          displayPath: parent === '/' ? `/${entry.name}` : `${parent}/${entry.name}`,
        },
      })
    }
    return listed
  }

  /**
   * The path a subprocess in this execution world opens for a target.
   *
   * The harness asks the filesystem provider how the execution world spells a
   * path — the headless bundle derives the session cwd from
   * `processPath(await resolve('.'))` — and this deployment's execution world is
   * the bubblewrap namespace, so the answer is the virtual path. Reporting the
   * host path here is what put one in the session cwd, in the persona suffix the
   * prompt renders from it, and in every loader that joins the session
   * workspace.
   *
   * @param target - a target from this backend.
   * @returns the virtual path, or the target key when no mount covers it.
   */
  override processPath(target: FsTarget): string {
    return hostToVirtual(String(target.targetKey), this.mounts()) ?? String(target.targetKey)
  }

  /**
   * Map a harness-host path onto the same file in this execution world.
   * @param hostPath - an absolute path in the harness host filesystem.
   * @returns the virtual path, or `undefined` when no mount covers `hostPath`.
   */
  override processPathFromHostPath(hostPath: string): string | undefined {
    return hostToVirtual(hostPath, this.mounts())
  }

  /** The mount table this deployment configured, anchored at its own host root. */
  private mounts(): ReturnType<typeof buildMounts> {
    return buildMounts(this.config.cwd, this.mountConfig)
  }

  /**
   * The virtual directory a relative path resolves against.
   *
   * A caller passes the session workspace, which is `/workspace` in a deployment
   * whose session cwd came from {@link processPath}. A session recorded before
   * the namespace existed passes its own host directory instead; that one maps
   * only when it IS a mount root, the string an operator wrote into the mount
   * table, so no other host path can anchor anything.
   *
   * @param cwd - the caller's working directory, when it named one.
   * @param mounts - the mounts in effect for this call.
   * @returns the virtual anchor.
   */
  private anchor(cwd: string | undefined, mounts: ReturnType<typeof buildMounts>): string {
    if (cwd === undefined) return VIRTUAL_WORKSPACE
    if (isVirtualPath(cwd, mounts)) return cwd
    return declaredRootFor(cwd, mounts) ?? VIRTUAL_WORKSPACE
  }

  /**
   * Run the mapping and translate its refusal into the seam's structured error.
   * @param requested - the caller's original path, for the message.
   * @param virtualPath - its absolute virtual form.
   * @param mounts - the mounts in effect for this call.
   * @returns the mapped host path and virtual name.
   * @throws {FsError} `FS_NOT_FOUND` whenever the mount table cannot name the path.
   */
  private map(
    requested: string,
    virtualPath: string,
    mounts: ReturnType<typeof buildMounts>,
  ): { host: string; virtual: string } {
    let mapped
    try {
      mapped = mapPath(virtualPath, mounts)
    } catch (error) {
      if (!(error instanceof PathDeniedError)) throw error
      if (process.env.BWRAP_TRACE !== undefined) traceRefusal(requested)
      throw notFound(requested)
    }
    if (mapped.host === FAKE_ROOT) {
      if (process.env.BWRAP_TRACE !== undefined) traceRefusal(requested)
      throw notFound(requested)
    }
    return { host: mapped.host, virtual: mapped.virtual }
  }

  /**
   * Write through the policy check, except into a mount the deployment made
   * writable.
   *
   * `SandboxedFileSystem` permits a mutation only under the policy's workspace
   * root and the platform temp areas, and no policy field widens that set — so a
   * store the operator deliberately exposed as writable has to bypass it here.
   * Everything else, `read-only` mode included, keeps the inherited check.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const inside = await this.insideWritableMount(target, sandboxPolicy)
    if (inside === undefined) return super.writeText(target, content, expected, signal, sandboxPolicy)
    return LocalFileSystem.prototype.writeText.call(this, inside, content, expected, signal)
  }

  /**
   * Edit through the policy check, with the same writable-mount exception as
   * {@link writeText}.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const inside = await this.insideWritableMount(target, sandboxPolicy)
    if (inside === undefined) return super.editText(target, edit, expected, signal, sandboxPolicy)
    return LocalFileSystem.prototype.editText.call(this, inside, edit, expected, signal)
  }

  /**
   * Re-canonicalize a mutation target that lies inside a mount configured
   * writable, and confirm it still does.
   *
   * The fresh resolution is the parent's anti-TOCTOU step: a symlink ancestor
   * swapped between the tool's own resolve and this call would otherwise move
   * the write elsewhere. Re-checking against the mount host narrows it here the
   * same way, and a target that escaped falls back to the inherited policy
   * check rather than being written.
   *
   * @param target - the resolved target of the pending mutation.
   * @param sandboxPolicy - the per-call policy; omit for the deployment default.
   * @returns the fresh target inside a writable mount, or `undefined` to use the
   *   inherited, workspace-only fence.
   */
  private async insideWritableMount(
    target: FsTarget,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsTarget | undefined> {
    const writable = this.mountConfig.writableRoots ?? []
    if (writable.length === 0) return undefined
    // `read-only` denies every mutation, this one included.
    const { mode } = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    if (mode !== 'workspace-write') return undefined
    const hosts = buildMounts(this.config.cwd, this.mountConfig)
      .filter(mount => writable.includes(mount.virtual))
      .map(mount => mount.host)
    if (!hosts.some(host => isUnder(target.targetKey, host))) return undefined
    const fresh = await this.resolve(target.displayPath)
    return hosts.some(host => isUnder(fresh.targetKey, host)) ? fresh : undefined
  }
}

/**
 * The error every path outside the mount table gets.
 *
 * A virtual name no mount reaches is a name the confined process cannot reach
 * either: the profile masks the home directories and mounts nothing else, so
 * the two views agree that it is absent. Reporting a boundary refusal instead
 * would make a caller that probes for a file — project-root discovery, skill
 * loading — read an ordinary absence as a broken backend and fail the whole
 * operation, which is how an ancestor `.git` probe used to abort AGENTS.md
 * loading.
 *
 * @param requested - the caller's original path, for the message.
 * @returns the error to throw.
 */
function notFound(requested: string): FsError {
  return new FsError(`cannot access ${JSON.stringify(requested)}: not found`, 'FS_NOT_FOUND')
}

/**
 * Temporary diagnostic: report a refused path with the frames that named it.
 * @param requested - the path the caller supplied.
 */
function traceRefusal(requested: string): void {
  const frames = (new Error().stack ?? '').split('\n').slice(1, 7).map(line => line.trim().replace(/^at /, ''))
  process.stderr.write(`BWRAP_TRACE ${JSON.stringify(requested)}\n${frames.join('\n')}\n\n`)
}

export default WorkspaceFileSystem

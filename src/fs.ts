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
import type { FsEditOutcome, FsEditRequest, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { Config as LocalFileConfig } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { assertMountConfig, buildMounts } from './mounts.js'
import type { MountConfig } from './mounts.js'
import { FAKE_ROOT, PathDeniedError, VIRTUAL_WORKSPACE, hostToVirtual, isUnder, mapPath, toVirtualPath } from './paths.js'

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
    const cwd = opts?.cwd ?? this.config.cwd
    const mounts = buildMounts(cwd, this.mountConfig)
    const virtualCwd = hostToVirtual(cwd, mounts) ?? VIRTUAL_WORKSPACE
    const virtualPath = hostToVirtual(path, mounts) ?? toVirtualPath(path, virtualCwd)
    const mapped = this.map(path, virtualPath, mounts)
    const target = await super.resolve(mapped.host, opts)
    return { targetKey: target.targetKey, displayPath: mapped.virtual }
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
      throw notFound(requested)
    }
    if (mapped.host === FAKE_ROOT) throw notFound(requested)
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

export default WorkspaceFileSystem

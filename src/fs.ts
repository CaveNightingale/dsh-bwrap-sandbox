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
 * This is a policy check in trusted code over a model-controlled path, not a
 * kernel boundary; kernel-grade isolation of running code stays
 * `bwrap-sandbox`'s job.
 *
 * @module dsh-bwrap-sandbox/fs
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { Config as LocalFileConfig } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { assertMountConfig, buildMounts } from './mounts.js'
import type { MountConfig } from './mounts.js'
import { FAKE_ROOT, PathDeniedError, VIRTUAL_WORKSPACE, hostToVirtual, mapPath, toVirtualPath } from './paths.js'

export const name = 'fs-bwrap'

/** Plugin config: the local backend's knobs plus the virtual namespace's mounts. */
export interface Config extends LocalFileConfig, MountConfig {}

export const Config: z<Config> = z.intersect([
  LocalFileSystem.Config,
  z.object({
    sessionsRoot: z.string().default(''),
    attachmentsRoot: z.string().default(''),
    spillRoot: z.string().default(''),
    additionalReadOnlyRoots: z.array(z.string()).default([]),
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
      additionalReadOnlyRoots: config.additionalReadOnlyRoots,
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
   * @throws {FsError} `FS_SANDBOX_DENIED` when no mount reaches the path.
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
   * @throws {FsError} `FS_SANDBOX_DENIED`.
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
      throw new FsError(`cannot access "${requested}": ${error.message}`, 'FS_SANDBOX_DENIED')
    }
    if (mapped.host === FAKE_ROOT) {
      throw new FsError(`cannot access "${requested}": the virtual root is not a file`, 'FS_SANDBOX_DENIED')
    }
    return { host: mapped.host, virtual: mapped.virtual }
  }
}

export default WorkspaceFileSystem

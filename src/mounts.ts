/**
 * The mount table both `fs-bwrap` and `guard-bwrap` resolve against.
 *
 * It lives in one place because the two plugins are deliberately independent:
 * the guard must keep working when the filesystem backend fails to load, so it
 * cannot inject it. The cost of that independence is that the two rows carry
 * matching config, and their mounts must describe the same namespace.
 *
 * @module dsh-bwrap-sandbox/mounts
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { canonicalizeHostPath, VIRTUAL_ATTACHMENTS, VIRTUAL_SESSIONS, VIRTUAL_SPILL, VIRTUAL_WORKSPACE } from './paths.js'
import type { Mount } from './paths.js'

/** The mount-relevant subset of the plugins' config. */
export interface MountConfig {
  /** Host session-log directory behind `/sessions`; empty resolves `$DSH_HOME/sessions`. */
  sessionsRoot?: string
  /** Host attachment store behind `/attachments`; empty resolves `$DSH_HOME/attachments`. */
  attachmentsRoot?: string
  /**
   * Host directory behind `/spill`; empty resolves `$DSH_HOME/spill`. Must match
   * the `spillRoot` of the `spill-bwrap` row — that plugin builds the locator
   * this mount has to reach, and the two are configured separately.
   */
  spillRoot?: string
  /**
   * Further host directories exposed under their own path. Each entry is one
   * top-level directory, because a virtual mount is a single name.
   */
  additionalReadOnlyRoots?: string[]
}

/**
 * Check the mount config for entries no virtual path could ever name.
 *
 * A virtual mount is a single top-level name, so `/var/tmp` would produce a
 * mount that `mapPath` never matches. Called at plugin load so the mistake
 * surfaces there rather than as a mysteriously unreachable directory.
 *
 * @param config - the mount-relevant config of the calling plugin.
 * @throws when an additional root is not a single top-level directory.
 */
export function assertMountConfig(config: MountConfig): void {
  for (const root of config.additionalReadOnlyRoots ?? []) {
    if (!/^\/[^/]+$/.test(root)) {
      throw new Error(
        `bwrap-sandbox: additionalReadOnlyRoots entry ${JSON.stringify(root)} must be a single top-level directory such as "/tmp"`,
      )
    }
  }
}

/**
 * Build the workspace's mount table.
 * @param workspaceHost - the calling session's workspace directory.
 * @param config - the mount-relevant config of the calling plugin.
 * @returns the mounts, workspace first.
 * @throws when an additional root is not a single top-level directory.
 */
export function buildMounts(workspaceHost: string, config: MountConfig = {}): Mount[] {
  assertMountConfig(config)
  return [
    { host: canonicalizeHostPath(workspaceHost), virtual: VIRTUAL_WORKSPACE },
    { host: canonicalizeHostPath(config.sessionsRoot || dshHomePath('sessions')), virtual: VIRTUAL_SESSIONS },
    { host: canonicalizeHostPath(config.attachmentsRoot || dshHomePath('attachments')), virtual: VIRTUAL_ATTACHMENTS },
    { host: canonicalizeHostPath(config.spillRoot || dshHomePath('spill')), virtual: VIRTUAL_SPILL },
    ...(config.additionalReadOnlyRoots ?? []).map(root => ({
      host: canonicalizeHostPath(root),
      virtual: root,
    })),
  ]
}

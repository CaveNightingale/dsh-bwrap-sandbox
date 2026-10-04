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

import { homedir } from 'node:os'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  canonicalizeHostPath,
  VIRTUAL_AGENTS,
  VIRTUAL_ATTACHMENTS,
  VIRTUAL_SESSIONS,
  VIRTUAL_SKILLS,
  VIRTUAL_SPILL,
  VIRTUAL_USER_INSTRUCTIONS,
  VIRTUAL_WORKSPACE,
} from './paths.js'
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
   * Host user-level agents home behind `/agents`; empty resolves
   * `$DSH_AGENTS_HOME` or `~/.agents`, the same default
   * `@deepseek-ai/dsh-skill-filesystem` reads its `user-agents` skills from.
   */
  agentsHome?: string
  /**
   * Host user-level DSH skill root behind `/skills`; empty resolves
   * `$DSH_HOME/skills`, the `user-dsh` skill root of the same loader.
   */
  skillsRoot?: string
  /**
   * Host user-global instruction file behind `/AGENTS.md`; empty resolves
   * `$DSH_HOME/AGENTS.md`, the single path
   * `@deepseek-ai/dsh-agent-instructions` reads user-global instructions from.
   */
  userInstructionsFile?: string
  /**
   * Further host directories exposed under their own path. Each entry is one
   * top-level directory, because a virtual mount is a single name.
   */
  additionalReadOnlyRoots?: string[]
  /**
   * Virtual mounts a confined process and the file tools may WRITE to, named as
   * their virtual roots (`/agents`, `/skills`, `/AGENTS.md`, an extra root).
   * Everything not listed stays read-only, and `read-only` mode still denies
   * every mutation.
   *
   * `bwrap-sandbox` binds a listed mount with `--bind` instead of `--ro-bind`,
   * and `fs-bwrap` admits the write; the other rows only validate the name, so a
   * typo fails at load instead of leaving a mount half writable. The two rows
   * must list the same mounts: a mount writable in one and read-only in the
   * other fails as `read-only file system` or as a denial, depending on which
   * gate ran first.
   */
  writableRoots?: string[]
}

/** A virtual mount name: exactly one top-level segment, no descendants. */
const MOUNT_NAME = /^\/[^/]+$/

/**
 * Every virtual root {@link buildMounts} can produce for this config.
 * @param config - the mount-relevant config of the calling plugin.
 * @returns the virtual roots, in mount order.
 */
function virtualRoots(config: MountConfig): string[] {
  return [
    VIRTUAL_WORKSPACE,
    VIRTUAL_SESSIONS,
    VIRTUAL_ATTACHMENTS,
    VIRTUAL_SPILL,
    VIRTUAL_AGENTS,
    VIRTUAL_SKILLS,
    VIRTUAL_USER_INSTRUCTIONS,
    ...(config.additionalReadOnlyRoots ?? []),
  ]
}

/**
 * File name of the user-global instruction file under `$DSH_HOME`.
 *
 * `@deepseek-ai/dsh-agent-instructions` reads exactly one user-global file and
 * keys that instruction scope on this name, so the mount default has to name the
 * same file or the instructions never load.
 */
export const USER_INSTRUCTIONS_FILE = 'AGENTS.md'

/**
 * Host directory the user-level agents home resolves to.
 *
 * The default mirrors `@deepseek-ai/dsh-skill-filesystem`, which reads its
 * `user-agents` skills from exactly this directory: a loader configured with a
 * different `agentsHome` needs the matching `agentsHome` here, or its skills
 * stay invisible to every tool.
 *
 * @returns the absolute host directory, whether or not it exists.
 */
export function defaultAgentsHome(): string {
  return process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')
}

/**
 * Check the mount config for entries no virtual path could ever name.
 *
 * A virtual mount is a single top-level name, so `/var/tmp` would produce a
 * mount that `mapPath` never matches. Called at plugin load so the mistake
 * surfaces there rather than as a mysteriously unreachable directory. A
 * `writableRoots` entry must name one of the mounts, because a name that reaches
 * nothing would quietly leave every mount read-only.
 *
 * @param config - the mount-relevant config of the calling plugin.
 * @throws when an additional root is not a single top-level directory, or a
 *   writable root names no mount.
 */
export function assertMountConfig(config: MountConfig): void {
  for (const root of config.additionalReadOnlyRoots ?? []) {
    if (!MOUNT_NAME.test(root)) {
      throw new Error(
        `bwrap-sandbox: additionalReadOnlyRoots entry ${JSON.stringify(root)} must be a single top-level directory such as "/tmp"`,
      )
    }
  }
  const roots = virtualRoots(config)
  for (const name of config.writableRoots ?? []) {
    if (!roots.includes(name)) {
      throw new Error(
        `bwrap-sandbox: writableRoots entry ${JSON.stringify(name)} names no mount; use one of ${roots.join(', ')}`,
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
    { host: canonicalizeHostPath(config.agentsHome || defaultAgentsHome()), virtual: VIRTUAL_AGENTS },
    { host: canonicalizeHostPath(config.skillsRoot || dshHomePath('skills')), virtual: VIRTUAL_SKILLS },
    // A single file, not its parent: `$DSH_HOME` also holds credentials.
    { host: canonicalizeHostPath(config.userInstructionsFile || dshHomePath(USER_INSTRUCTIONS_FILE)), virtual: VIRTUAL_USER_INSTRUCTIONS },
    ...(config.additionalReadOnlyRoots ?? []).map(root => ({
      host: canonicalizeHostPath(root),
      virtual: root,
    })),
  ]
}

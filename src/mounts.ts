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
import { isAbsolute, join } from 'node:path'
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
   * Further host directories exposed read-only, as `{ <name>: <host directory> }`.
   *
   * The key is the namespace name and the value is the host directory behind it,
   * because the two are separate facts: a mount point is one name created on the
   * namespace root, while the host directory may be nested
   * (`my_files: /home/deepseek/my_files`) and has no single-segment name of its
   * own. The key is a single top-level segment, with or without its leading
   * slash (`my_files` and `/my_files` both mean `/my_files`); anything nested
   * fails at load, because a virtual mount is one name and a read-only bind
   * cannot host a mount point inside it.
   */
  additionalReadOnlyRoots?: Record<string, string>
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
const MOUNT_NAME = /^\/(?!\.{1,2}$)[^/]+$/

/**
 * The namespace path an additional root's key names.
 * @param name - the configured key, with or without its leading slash.
 * @returns the absolute single-segment path.
 * @throws when the key is empty, nested, or names the namespace root.
 */
export function extraRootName(name: string): string {
  const at = name.startsWith('/') ? name : `/${name}`
  if (!MOUNT_NAME.test(at)) {
    throw new Error(
      `bwrap-sandbox: additionalReadOnlyRoots key ${JSON.stringify(name)} must be a single top-level name such as "my_files" or "/tmp"`,
    )
  }
  return at
}

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
    ...Object.keys(config.additionalReadOnlyRoots ?? {}).map(extraRootName),
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
  for (const [name, host] of Object.entries(config.additionalReadOnlyRoots ?? {})) {
    extraRootName(name)
    if (host.length === 0 || !isAbsolute(host)) {
      throw new Error(
        `bwrap-sandbox: additionalReadOnlyRoots["${name}"] must be an absolute host directory, got ${JSON.stringify(host)}`,
      )
    }
  }
  const roots = virtualRoots(config)
  // One name, one mount: a second mount at the same path would replace the first
  // in the sandbox and shadow it in the mount table, silently.
  const taken = new Set<string>(['/tmp'])
  for (const name of roots) {
    if (taken.has(name)) {
      throw new Error(`bwrap-sandbox: ${JSON.stringify(name)} is named by two mounts; pick another additionalReadOnlyRoots name`)
    }
    taken.add(name)
  }
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
    ...Object.entries(config.additionalReadOnlyRoots ?? {}).map(([name, host]) => ({
      host: canonicalizeHostPath(host),
      virtual: extraRootName(name),
    })),
  ]
}

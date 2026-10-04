/**
 * The virtual-namespace path mapping shared by the sandbox provider, the
 * filesystem backend, and the tool guard.
 *
 * The model names files in a virtual namespace whose top level holds only the
 * mounted roots. {@link mapPath} walks a virtual path and returns both
 * coordinates, keeping them in step at every step:
 *
 * - `..` pops the last segment of the already-mapped parent, so it follows the
 *   kernel's symlink-then-`..` order instead of removing a textual prefix.
 * - A symlink's target is read in the VIRTUAL namespace, because that is the
 *   namespace the process that wrote it could see: a link holding `/etc` maps to
 *   the virtual `/etc`, whose top-level name is not a mount and is refused, and
 *   a link holding a host path is dangling here exactly as it is inside the
 *   sandbox.
 * - Every host path is therefore `<mount host>` plus virtual segments, which
 *   makes containment structural: there is no second check to forget.
 *
 * The returned virtual path is the canonical one, so `/workspace/a/../b` and
 * `/workspace/b` agree; the model is shown where a file actually is, not how it
 * happened to spell the way there.
 *
 * @module dsh-bwrap-sandbox/paths
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { posix, sep } from 'node:path'

/** Virtual root the session workspace is presented at, inside and outside the sandbox. */
export const VIRTUAL_WORKSPACE = '/workspace'

/** Virtual root the harness session-log store is presented at. */
export const VIRTUAL_SESSIONS = '/sessions'

/** Virtual root the harness attachment store is presented at. */
export const VIRTUAL_ATTACHMENTS = '/attachments'

/**
 * Virtual root spilled tool output is written to and read back from.
 *
 * It is a mount like any other, so a locator handed to the model names the same
 * directory a confined process sees. That is the whole reason this package
 * replaces the stock spill backend, which reports a host path.
 */
export const VIRTUAL_SPILL = '/spill'

/** Identity of the virtual root, which stands for no host directory of its own. */
export const FAKE_ROOT = Symbol('dsh-bwrap-sandbox/virtual-root')

/** The type of {@link FAKE_ROOT}; a mapped host is either a real path or this. */
export type FakeRoot = typeof FAKE_ROOT

/** Longest chain of symlink hops one mapping follows before refusing. */
const MAX_SYMLINK_HOPS = 40

/** One host directory exposed under a virtual path exactly one segment deep. */
export interface Mount {
  /** Absolute host directory. */
  readonly host: string
  /** Absolute virtual path naming it, e.g. `/workspace` or `/tmp`. */
  readonly virtual: string
}

/** The pair {@link mapPath} returns: where a virtual path lives, and its name. */
export interface MappedPath {
  /** Host directory or file, or {@link FAKE_ROOT} when the path is the virtual root. */
  readonly host: string | FakeRoot
  /** Canonical virtual path, which is the caller's path with every alias resolved. */
  readonly virtual: string
}

/** A virtual path that names nothing reachable, carrying the reason it was refused. */
export class PathDeniedError extends Error {
  /** The virtual path that was refused. */
  readonly virtualPath: string

  /**
   * @param virtualPath - the offending virtual path.
   * @param message - why it was refused, phrased for the model.
   */
  constructor(virtualPath: string, message: string) {
    super(message)
    this.name = 'PathDeniedError'
    this.virtualPath = virtualPath
  }
}

/** Normalize one path for comparison: drop a trailing separator, keep the root. */
export function trimSeparator(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path
}

/** Whether `candidate` is `root` itself or lies beneath it, compared by segments. */
export function isUnder(candidate: string, root: string): boolean {
  const child = trimSeparator(candidate)
  const parent = trimSeparator(root)
  return child === parent || child.startsWith(`${parent}${sep}`)
}

/**
 * Resolve a mount's host directory to its canonical path, so two mounts built
 * from differently spelled but identical directories compare equal.
 * @param input - an absolute host path.
 * @returns the canonical path, or `input` when the directory does not exist yet.
 */
export function canonicalizeHostPath(input: string): string {
  try {
    return realpathSync.native(input)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return input
    throw error
  }
}

/**
 * Absolute virtual path for a path a caller supplied.
 *
 * An already absolute path is taken as virtual, and a relative path joins the
 * virtual cwd. Nothing is normalized here: `..` and symlinks are `mapPath`'s
 * job, and collapsing them textually first would resolve them in the wrong
 * namespace.
 *
 * @param path - a model- or plugin-supplied path.
 * @param virtualCwd - the virtual directory relative paths resolve against.
 * @returns the absolute virtual path.
 */
export function toVirtualPath(path: string, virtualCwd: string): string {
  if (path.startsWith('/')) return path
  const base = virtualCwd.endsWith('/') ? virtualCwd.slice(0, -1) : virtualCwd
  return `${base}/${path}`
}

/**
 * Rewrite a host path under a mount into its virtual form.
 *
 * The harness hands host paths to these seams — a session cwd, a recorded
 * attachment — and they must stay usable, but only where a mount already covers
 * them. A host path outside every mount has no virtual spelling, which is what
 * makes a stray alias such as `ln -s /real/workspace /sbin/ws` unusable: the
 * alias is not under any mount, and its virtual reading `/sbin/...` names no
 * mount either.
 *
 * @param hostPath - an absolute host path.
 * @param mounts - the mounts in effect for this call.
 * @returns the virtual path, or `undefined` when no mount covers `hostPath`.
 */
export function hostToVirtual(hostPath: string, mounts: readonly Mount[]): string | undefined {
  const target = trimSeparator(hostPath)
  for (const mount of mounts) {
    const root = trimSeparator(mount.host)
    if (isUnder(target, root)) return `${trimSeparator(mount.virtual)}${target.slice(root.length)}`
  }
  return undefined
}

/**
 * Map an absolute virtual path onto the host filesystem, deciding as it goes
 * whether the caller may name it at all.
 *
 * The walk recurses on the parent first, so by the time a segment is joined its
 * parent's host directory is known, `.`/`..` act on the MAPPED parent, and a
 * symlink is expanded by mapping its target as a virtual path. Refusal happens
 * at the first segment that cannot be placed.
 *
 * @param virtualPath - an absolute virtual path.
 * @param mounts - the mounts in effect for this call.
 * @returns the host path and the virtual name to present for it.
 * @throws {PathDeniedError} when the path is relative, leaves the mounts, or
 *   follows more symlink hops than {@link MAX_SYMLINK_HOPS}.
 */
export function mapPath(virtualPath: string, mounts: readonly Mount[]): MappedPath {
  if (!virtualPath.startsWith('/')) {
    throw new PathDeniedError(virtualPath, `"${virtualPath}" is not an absolute virtual path`)
  }
  // A mapping is a snapshot of one call; sharing answers for repeated prefixes
  // keeps a deep path linear instead of quadratic in `lstat` calls.
  const resolved = new Map<string, MappedPath>()
  let hops = 0

  const walk = (current: string): MappedPath => {
    const cached = resolved.get(current)
    if (cached !== undefined) return cached
    const mapped = step(current)
    resolved.set(current, mapped)
    return mapped
  }

  const step = (current: string): MappedPath => {
    if (current === '/') return { host: FAKE_ROOT, virtual: '/' }
    const parent = walk(posix.dirname(current))
    const name = posix.basename(current)

    // `.` keeps the mapped parent as it is.
    if (name === '.') return parent
    // `..` pops the MAPPED parent, so it lands where the kernel would after
    // following whatever symlink produced that parent.
    if (name === '..') return walk(posix.dirname(parent.virtual))

    if (parent.host === FAKE_ROOT) {
      // Only a mount's virtual root may be named at the top level.
      const mount = mounts.find(candidate => candidate.virtual === `/${name}`)
      if (mount === undefined) {
        throw new PathDeniedError(current, `"${current}" is outside every visible root`)
      }
      return { host: mount.host, virtual: mount.virtual }
    }

    const host = posix.join(parent.host, name)
    const target = readLinkTarget(host)
    if (target === undefined) return { host, virtual: posix.join(parent.virtual, name) }
    hops += 1
    if (hops > MAX_SYMLINK_HOPS) {
      throw new PathDeniedError(current, `"${current}" follows more than ${MAX_SYMLINK_HOPS} symbolic links`)
    }
    return walk(expandLink(parent.virtual, target))
  }

  return walk(virtualPath)
}

/**
 * Interpret a symlink target in the virtual namespace.
 *
 * The text of a link is what the process that created it resolved against, and
 * a process inside the sandbox resolves `/workspace` and `/sessions`, never a
 * host path. Reading an absolute target as a host path instead would let the
 * file tools follow a link that is dangling under `bash` — the workspace bound
 * at `/workspace` is not at `<workspace>` there, and every home directory is an
 * empty tmpfs — so the two views of the same directory would disagree. A host
 * path in a link is therefore refused, and such a link is repaired by making it
 * relative or spelling it `/workspace/...`, which then works in both views.
 *
 * @param parentVirtual - the virtual directory holding the link.
 * @param target - the raw `readlink` result.
 * @returns the virtual path the target names.
 */
function expandLink(parentVirtual: string, target: string): string {
  if (target.startsWith('/')) return target
  return parentVirtual === '/' ? `/${target}` : `${parentVirtual}/${target}`
}

/**
 * Read a host path's symlink target.
 * @param host - an absolute host path.
 * @returns the target, or `undefined` when the path is not a symlink or does not
 *   exist (a new file maps as itself).
 * @throws when the path cannot be inspected for any other reason.
 */
function readLinkTarget(host: string): string | undefined {
  try {
    if (!lstatSync(host).isSymbolicLink()) return undefined
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
  return readlinkSync(host)
}

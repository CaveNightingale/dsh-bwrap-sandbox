/**
 * `/spill` spill storage: the `ctx.spillStore` provider that reports a VIRTUAL
 * locator.
 *
 * The stock `dsh-spill-local` returns the absolute host path of the artifact and
 * tells the model to `read` or `grep` it. Under this package that locator names
 * no mount, so the retrieval it promises cannot happen, and the host path lands
 * in the session log. This backend writes the same bytes to a session-scoped
 * file and reports `/spill/...` instead: the mount table resolves it, a confined
 * process reads the same file at the same path, and no host path reaches the
 * model.
 *
 * Only storage is replaced. Retention, the omission notice, and image handling
 * stay in `dsh-spill-policy` and `dsh-output-retention`, which reach this backend
 * through the one-method `ctx.spillStore` seam.
 *
 * @module dsh-bwrap-sandbox/spill
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readdir, rm, rmdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { VIRTUAL_SPILL } from './paths.js'

export const name = 'spill-bwrap'

/**
 * Retrieval guidance for a locator. The wording is the stock one because it
 * stays true: the locator is a path both `read` and `grep` accept, and here it
 * is also the path a confined process sees.
 */
const RETRIEVAL_HINT = 'Use read with offset/limit, or grep this path to search within it.'

/** Milliseconds in one day, converting `cleanupPeriodDays` into a sweep cutoff. */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Prefix identifying a session directory, so the sweep never touches anything else. */
const SESSION_DIR_PREFIX = 'session-'

/** Attempts to place one artifact before giving up, covering a name collision or a pruned directory. */
const WRITE_ATTEMPTS = 5

/** Characters kept literal in a filename segment; everything else is escaped. */
const SAFE_SEGMENT_CHARACTER = /^[A-Za-z0-9._-]$/

/** Plugin config. `spillRoot` must match the same field on the other three rows. */
export interface Config {
  /** Host directory backing `/spill`; empty resolves `$DSH_HOME/spill`. */
  spillRoot?: string
  /**
   * Age in days after which a spill file is reclaimed by the one best-effort
   * sweep at activation. `0` disables the sweep. Retention is deliberate: a
   * resumed or forked session may still reference an older locator until it ages
   * out.
   */
  cleanupPeriodDays?: number
}

export const Config: z<Config> = z.object({
  spillRoot: z.string().default(''),
  cleanupPeriodDays: z.number().step(1).min(0).default(30),
})

/** Validated config, after schemastery filled `cleanupPeriodDays`. */
interface ResolvedConfig {
  cleanupPeriodDays: number
}

/**
 * Encode arbitrary text as one filesystem-safe path segment.
 *
 * `suggestedName` comes from the caller and is never a path: escaping every
 * separator keeps the result a single segment, so `../`, an absolute path, and a
 * NUL cannot traverse. `~` is escaped too, so the mapping is injective over code
 * units and distinct names never collide. An empty name becomes `~` rather than
 * an empty segment.
 *
 * @param raw - the caller's suggested base name.
 * @returns one safe path segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    out += character !== '~' && SAFE_SEGMENT_CHARACTER.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * The session-scoped directory name. The session id is hashed rather than used
 * literally, so a session id can never be read back out of the store's layout.
 *
 * @param sessionId - the owning session.
 * @returns the directory name below the spill root.
 */
export function sessionDirectoryName(sessionId: string): string {
  return `${SESSION_DIR_PREFIX}${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`
}

/**
 * Spill backend for the `/spill` mount.
 *
 * Artifacts are `0600` files inside a `0700` session directory with
 * unpredictable names, so a spilled tool result is not readable by another
 * local user and cannot be redirected through a planted symlink. `saveText`
 * rejects on a real storage failure; the caller keeps its inline result.
 */
export class BwrapSpillStore extends SpillStore {
  static Config: z<Config> = Config

  /** Absolute host spill root, fixed at construction. */
  readonly root: string

  /** The in-flight (or settled) activation sweep; `undefined` when cleanup is disabled. */
  private cleanup: Promise<void> | undefined

  private readonly resolved: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = resolve((config.spillRoot as string) || dshHomePath('spill'))
    this.resolved = config as ResolvedConfig

    // One best-effort sweep at activation. The body starts it without awaiting,
    // and yields a disposer that awaits the same promise, so availability is
    // never delayed yet a fiber unload still reaches quiescence.
    ctx.effect(function (this: BwrapSpillStore) {
      if (this.resolved.cleanupPeriodDays > 0) this.cleanup = this.sweep()
      return async () => { await this.cleanup }
    }.bind(this), 'bwrap-sandbox spill sweep')
  }

  /**
   * Persist the full text and return a virtual locator for it.
   * @param input - the owner, source description, suggested name, and full text.
   * @returns the locator, exact UTF-8 byte length, and retrieval guidance.
   * @throws when the file cannot be written; the caller keeps its inline result.
   */
  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const directory = join(this.root, sessionDirectoryName(input.owner.sessionId))
    let lastError: unknown
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const segment = `${randomBytes(6).toString('hex')}-${encodeSegment(input.suggestedName)}`
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const handle = await open(join(directory, segment), 'wx', 0o600)
        try {
          await handle.writeFile(input.content)
        } finally {
          await handle.close()
        }
        return {
          locator: SpillLocator(`${VIRTUAL_SPILL}/${sessionDirectoryName(input.owner.sessionId)}/${segment}`),
          bytes: Buffer.byteLength(input.content, 'utf8'),
          retrievalHint: RETRIEVAL_HINT,
        }
      } catch (error) {
        // A name collision or a concurrently pruned directory is worth another
        // try; anything else fails the save.
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'ENOENT') throw error
        lastError = error
      }
    }
    throw lastError
  }

  /**
   * Delete artifacts older than `cleanupPeriodDays` and prune the session
   * directories they empty.
   *
   * Every filesystem failure is contained and logged, so a sweep never delays
   * availability, never fails activation, and never turns into an unhandled
   * rejection on disposal. Symlinks and non-files are skipped, and a directory
   * is removed only when `rmdir` finds it empty, which keeps the sweep inside
   * the store's own layout.
   */
  private async sweep(): Promise<void> {
    const cutoff = Date.now() - this.resolved.cleanupPeriodDays * MS_PER_DAY
    let roots: Dirent[]
    try {
      roots = await this.entries(this.root)
    } catch (error) {
      this.warn(this.root, error)
      return
    }
    for (const entry of roots) {
      // A session directory is the only shape this store creates.
      if (!entry.isDirectory() || !entry.name.startsWith(SESSION_DIR_PREFIX)) continue
      const directory = join(this.root, entry.name)
      try {
        await this.sweepSession(directory, cutoff)
      } catch (error) {
        this.warn(directory, error)
      }
    }
  }

  /**
   * Reclaim the expired artifacts of one session directory, then prune it if
   * that emptied it.
   * @param directory - an absolute session directory.
   * @param cutoff - epoch milliseconds; artifacts at or after it are kept.
   * @throws when the directory cannot be read.
   */
  private async sweepSession(directory: string, cutoff: number): Promise<void> {
    for (const artifact of await this.entries(directory)) {
      // `isFile()` is false for a symlink, so a planted link is left alone.
      if (!artifact.isFile()) continue
      const path = join(directory, artifact.name)
      try {
        if ((await stat(path)).mtimeMs >= cutoff) continue
        await rm(path, { force: true })
      } catch (error) {
        this.warn(path, error)
      }
    }
    try {
      await rmdir(directory)
    } catch (error) {
      // `rmdir` removes only an empty directory, so ENOTEMPTY is the ordinary
      // outcome whenever a fresh artifact survives the cutoff.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTEMPTY' && code !== 'ENOENT') this.warn(directory, error)
    }
  }

  /**
   * List a directory, treating absence as empty.
   * @param directory - the directory to list.
   * @returns its entries, or an empty list when it does not exist yet.
   * @throws when the directory cannot be read for any other reason.
   */
  private async entries(directory: string): Promise<Dirent[]> {
    try {
      return await readdir(directory, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return []
      throw error
    }
  }

  /**
   * Report a contained sweep failure.
   * @param path - the path the sweep was working on.
   * @param error - the contained failure.
   */
  private warn(path: string, error: unknown): void {
    this.ctx.logger.warn(`bwrap-sandbox spill sweep: cannot reclaim ${path}: ${String(error)}`)
  }
}

export default BwrapSpillStore

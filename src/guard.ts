/**
 * Tool-path guard for the model-facing tools that reach the filesystem without
 * passing through `ctx.fs`.
 *
 * `grep` and `glob` spawn the packaged ripgrep binary directly (they inject
 * `subprocess`, deliberately not `fs`), and `lsp` drives language servers, so
 * the backend fence cannot see their arguments. `ctx.tools.guard()` is the one
 * checkpoint every dispatch passes — including nested PTC dispatches — and it is
 * monotonic: a later listener can never force-allow a call this guard denied.
 *
 * The guard applies the same {@link mapPath} walk the backend does, so the two
 * fences agree by construction: a path outside the mounts is refused here for
 * the same reason it is refused there.
 *
 * A guard returns a denial reason or `undefined`; it cannot rewrite arguments,
 * because a tool call's arguments are already logged and presented by the time
 * the guard runs. That is why this one refuses a host path rather than
 * translating it — the tools it covers default to the session workspace and
 * accept workspace-relative paths, which is the intended way to name a file.
 *
 * Which tools it covers, and which argument of each names a path, is config
 * ({@link Config.pathArguments} and {@link Config.pathArrayArguments}), whose
 * defaults are the shipped tables, because the mounted tool set varies by
 * deployment.
 *
 * @module dsh-bwrap-sandbox/guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { assertMountConfig, buildMounts } from './mounts.js'
import type { MountConfig } from './mounts.js'
import { FAKE_ROOT, PathDeniedError, VIRTUAL_WORKSPACE, hostToVirtual, mapPath, toVirtualPath } from './paths.js'

export const name = 'guard-bwrap'
export const inject = ['tools']

/**
 * Plugin config. The mount fields must match the `fs-bwrap` row: the two plugins
 * are independent — the guard must survive the backend failing to load — so they
 * cannot share a config object.
 */
export interface Config extends MountConfig {
  /**
   * The host directory the mount table anchors at. Empty resolves the process
   * working directory. The guard reads it instead of the session cwd because the
   * session cwd is an execution-world path, and the mount table's host side is
   * the deployment's own.
   */
  workspace?: string
  /**
   * Tools to fence, mapped to the argument that names one filesystem path. The
   * shipped table is this field's default, so setting it replaces the whole
   * table; copy the default from `dsh --dump-config` to extend it.
   */
  pathArguments?: Record<string, string>
  /**
   * Tools to fence, mapped to the argument holding a list of `{ path }` entries.
   * The shipped table is this field's default; setting it replaces it.
   */
  pathArrayArguments?: Record<string, string>
}

/** One table of tools the guard covers and the argument each names a path in. */
type ArgumentTable = Record<string, string>

/** The tool → argument tables a guard closure resolves with. */
export interface ArgumentTables {
  /** Tools taking one path. */
  pathArguments: ArgumentTable
  /** Tools taking a list of `{ path }` entries. */
  pathArrayArguments: ArgumentTable
}

/**
 * Tools the guard covers by default, mapped to the argument naming one
 * filesystem path.
 *
 * Two kinds of argument need this check. `grep`, `glob`, and `lsp` reach the
 * filesystem without passing through `ctx.fs`, so only a guard stands in front
 * of them. The rest are here because the backends absorb the host spellings the
 * harness itself uses, and a tool argument is the model's rather than the
 * harness's — this check is where that distinction is still visible, since
 * `bash` and `pwsh` resolve `workdir` in the provider and `terminal` hands
 * `cwd` to a provider this package does not own.
 *
 * This constant is the default of {@link Config.pathArguments}.
 */
export const DEFAULT_PATH_ARGUMENTS: Readonly<ArgumentTable> = {
  read: 'file_path',
  read_image: 'file_path',
  write: 'file_path',
  edit: 'file_path',
  str_replace_editor: 'path',
  grep: 'path',
  glob: 'path',
  lsp: 'file_path',
  bash: 'workdir',
  pwsh: 'workdir',
  terminal: 'cwd',
}

/**
 * Tools the guard covers by default, mapped to the argument holding a list of
 * `{ path }` entries. The default of {@link Config.pathArrayArguments}.
 */
export const DEFAULT_PATH_ARRAY_ARGUMENTS: Readonly<ArgumentTable> = {
  present: 'files',
}

export const Config: z<Config> = z.object({
  workspace: z.string().default(''),
  sessionsRoot: z.string().default(''),
  attachmentsRoot: z.string().default(''),
  spillRoot: z.string().default(''),
  agentsHome: z.string().default(''),
  skillsRoot: z.string().default(''),
  userInstructionsFile: z.string().default(''),
  additionalReadOnlyRoots: z.dict(z.string()).default({}),
  writableRoots: z.array(z.string()).default([]),
  pathArguments: z.dict(z.string()).default({ ...DEFAULT_PATH_ARGUMENTS }),
  pathArrayArguments: z.dict(z.string()).default({ ...DEFAULT_PATH_ARRAY_ARGUMENTS }),
})

/** The config after schemastery filled the table defaults. */
interface ResolvedConfig extends MountConfig {
  pathArguments: Record<string, string>
  pathArrayArguments: Record<string, string>
}

/**
 * Resolve the tables one guard closure runs with.
 *
 * The value is the WHOLE table, not an overlay. A deployment that covers a
 * different tool set states that set, and a tool left out is a tool the guard
 * does not inspect — so an entry that names the wrong argument guards nothing at
 * all. `dsh --dump-config` prints the shipped table to copy from.
 *
 * The config passes through {@link Config} here even though cordis already did,
 * because the shipped table is the field default and that must be the only place
 * it is spelled: a caller handing over a raw object would otherwise get an empty
 * table, which is a guard that fences nothing.
 *
 * @param config - the plugin config, validated or raw.
 * @returns the tables to fence with, copied so a caller cannot mutate the
 *   schema's default.
 * @throws when a tool name or its argument is blank, or when one tool is listed
 *   in both tables.
 */
export function resolveArgumentTables(config: Config): ArgumentTables {
  // schemastery has filled both table defaults by here.
  const resolved = Config(config) as ResolvedConfig
  const tables = {
    pathArguments: checkTable('pathArguments', resolved.pathArguments),
    pathArrayArguments: checkTable('pathArrayArguments', resolved.pathArrayArguments),
  }
  for (const tool of Object.keys(tables.pathArguments)) {
    if (tool in tables.pathArrayArguments) {
      throw new Error(`guard-bwrap: "${tool}" is listed in both pathArguments and pathArrayArguments`)
    }
  }
  return tables
}

/**
 * Validate one configured table and copy it.
 * @param label - the config field name, for messages.
 * @param table - the configured table.
 * @returns a mutable copy.
 * @throws when a tool name or its argument is blank, which would fence nothing.
 */
function checkTable(label: string, table: Record<string, string>): ArgumentTable {
  const checked: ArgumentTable = {}
  for (const [tool, argument] of Object.entries(table)) {
    if (tool.trim().length === 0) throw new Error(`guard-bwrap: ${label} has a blank tool name`)
    if (argument.trim().length === 0) {
      throw new Error(`guard-bwrap: ${label}["${tool}"] is blank; list the argument it names a path in`)
    }
    checked[tool] = argument
  }
  return checked
}

/**
 * Read the string paths one call carries, in argument order.
 * @param exec - the pending tool call.
 * @param tables - the tool → argument tables in effect.
 * @returns the paths, or `undefined` when the tool takes none.
 */
function candidatePaths(exec: Readonly<ToolExecution>, tables: ArgumentTables): readonly unknown[] | undefined {
  const single = tables.pathArguments[exec.name]
  const list = tables.pathArrayArguments[exec.name]
  if (single === undefined && list === undefined) return undefined
  const args = exec.arguments as Record<string, unknown> | null | undefined
  if (args === null || args === undefined) return []
  if (single !== undefined) return [args[single]]
  const entries = args[list as string]
  if (!Array.isArray(entries)) return []
  return entries.map(entry => {
    if (typeof entry !== 'object' || entry === null) return undefined
    return (entry as { path?: unknown }).path
  })
}

/**
 * Install the guard. It runs for every agent because it registers on the plain
 * plugin context.
 * @param ctx - the plugin context.
 * @param config - the mounts and argument tables to resolve against.
 */
export function apply(ctx: Context, config: Config): void {
  // Fail at load, not as an unreachable directory or missing guard later.
  assertMountConfig(config)
  const tables = resolveArgumentTables(config)
  ctx.tools.guard((exec: Readonly<ToolExecution>): string | undefined => {
    const candidates = candidatePaths(exec, tables)
    if (candidates === undefined || candidates.length === 0) return undefined
    const mounts = buildMounts((config.workspace as string) || process.cwd(), config)

    for (const candidate of candidates) {
      // An omitted path means "the session workspace", which is always allowed.
      if (candidate === undefined || candidate === null) continue
      if (typeof candidate !== 'string') {
        return `path boundary: ${exec.name} received a non-string path; denying`
      }
      // A tool argument is the model's. The backend also absorbs the durable
      // host spellings the harness names (the session cwd, recorded paths),
      // but those never reach a model: every result presents `displayPath`.
      // Accepting one here would give the model two names for one file, of
      // which only one exists inside `bash`.
      //
      // The refusal is the same one any path the sandbox does not have gets, down
      // to its wording: a distinct answer — naming the visible path, or saying
      // the argument was host-spelled — would tell the caller which of its
      // guesses named a real host file and where that file lives in the
      // namespace. This reply reveals neither.
      const virtual = hostToVirtual(candidate, mounts)
      if (virtual !== undefined && virtual !== candidate) return notFound(candidate)
      const virtualPath = virtual ?? toVirtualPath(candidate, VIRTUAL_WORKSPACE)
      try {
        const mapped = mapPath(virtualPath, mounts)
        if (mapped.host === FAKE_ROOT) return notFound(candidate)
      } catch (error) {
        // Fail closed: a path that cannot be placed, or cannot be inspected at
        // all, is not a path this guard can vouch for.
        if (error instanceof PathDeniedError) return notFound(candidate)
        return `path boundary: ${JSON.stringify(candidate)}: cannot inspect it (${String(error)})`
      }
    }
    return undefined
  })
}

/**
 * The message every path outside the mount table gets, for both the virtual
 * root and a top-level name no mount covers.
 *
 * The guard denies the call either way — `grep` and `glob` reach the host
 * filesystem without passing through `ctx.fs`, so only this check stands in
 * front of them. The wording is the namespace's answer rather than a boundary
 * report: a path the sandbox does not have reads as missing, the way it does for
 * the backend, and the fence's shape is not disclosed to the model. A host
 * spelling gets this same message, so the answer never says whether the caller
 * named a file the sandbox has under another name.
 *
 * @param candidate - the tool's argument, for the message.
 * @returns the denial reason.
 */
function notFound(candidate: string): string {
  return `cannot access ${JSON.stringify(candidate)}: not found`
}

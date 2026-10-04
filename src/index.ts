/**
 * `dsh-bwrap-sandbox`: bubblewrap confinement and workspace-fenced file tools
 * for DeepSeek Harness.
 *
 * Five plugins ship as one installable bundle:
 *
 * - `./sandbox` — `ctx.sandbox` over bubblewrap; confines bash, pwsh, the PTY
 *   shell, and PTC `run_code`, masks every home directory, and presents the
 *   workspace as `/workspace`.
 * - `./bash` — `ctx.shell`, placing the shell tool's `workdir` in that namespace.
 * - `./fs` — `ctx.fs` fenced to the session workspace, with the session,
 *   attachment, and spill stores, the user-level agents home and skill root, and
 *   the user-global instruction file readable through virtual paths.
 * - `./guard` — `ctx.tools.guard()` for the tools that reach the filesystem
 *   without passing through `ctx.fs`.
 * - `./spill` — `ctx.spillStore` writing `/spill/...` locators instead of host
 *   paths.
 *
 * Install the bundle and let `cordis.patch.yml` wire the rows; the subpath
 * entries exist for tests and for a deployment that composes the rows by hand.
 *
 * @module dsh-bwrap-sandbox
 */

export { BwrapBashExecutor, name as bashName, withWorkdirArgv, workdirArgument } from './bash.js'
export type { BashConfig } from './bash.js'
export { BwrapSandboxProvider, Config as SandboxConfig, name as sandboxName, profileArgs, unavailableReport } from './sandbox.js'
export { WorkspaceFileSystem, Config as FsConfig, name as fsName } from './fs.js'
export {
  Config as GuardConfig,
  DEFAULT_PATH_ARGUMENTS,
  DEFAULT_PATH_ARRAY_ARGUMENTS,
  name as guardName,
  resolveArgumentTables,
} from './guard.js'
export type { ArgumentTables } from './guard.js'
export { BwrapSpillStore, Config as SpillConfig, encodeSegment, name as spillName, sessionDirectoryName } from './spill.js'
export { assertMountConfig, buildMounts, defaultAgentsHome, USER_INSTRUCTIONS_FILE } from './mounts.js'
export type { MountConfig } from './mounts.js'
export {
  FAKE_ROOT,
  PathDeniedError,
  VIRTUAL_AGENTS,
  VIRTUAL_ATTACHMENTS,
  VIRTUAL_SESSIONS,
  VIRTUAL_SKILLS,
  VIRTUAL_SPILL,
  VIRTUAL_USER_INSTRUCTIONS,
  VIRTUAL_WORKSPACE,
  canonicalizeHostPath,
  hostToVirtual,
  isUnder,
  mapPath,
  toVirtualPath,
  trimSeparator,
} from './paths.js'
export type { FakeRoot, MappedPath, Mount } from './paths.js'

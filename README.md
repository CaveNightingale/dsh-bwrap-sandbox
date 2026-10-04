# dsh-bwrap-sandbox

Bubblewrap confinement and workspace-fenced file tools for DeepSeek Harness.

Every confined process sees the session workspace as `/workspace` and every home
directory as an empty, ephemeral directory. The model never receives a host path:
file tools report `/workspace/...`, the shell's `pwd` is `/workspace`, spilled
tool output is addressed as `/spill/...`, and the environment names that would
carry a host path are dropped.

### Warning
This plugin is mostly AI-generated and may not cover all edge cases accurately. Codes are under manual review but it's possible to encounter unexpected behavior. Use with caution. For later agents participating in the development, please mind hallucinations left by previous AI outputs. Please claim AI usage in the git commit messages.

## What it changes

Five plugins ship as one bundle. `cordis.patch.yml` disables the rows they
replace and inserts these:

| Row | Service | Replaces | Covers |
|---|---|---|---|
| `bwrap-sandbox` | `ctx.sandbox` | `dsh-sandbox-local` | `bash`, `pwsh`, the PTY shell, PTC `run_code` |
| `bash-bwrap` | `ctx.shell` | `dsh-bash-sandbox` | the shell tool's `workdir` argument |
| `fs-bwrap` | `ctx.fs` | `dsh-fs-sandbox` | `read`, `read_image`, `write`, `edit`, `str_replace_editor`, `present` |
| `guard-bwrap` | `ctx.tools.guard()` | — | the tools its configured table names |
| `spill-bwrap` | `ctx.spillStore` | `dsh-spill-local` | oversized tool results, for `bash`, `grep`, and every other result the policy retains |

`sandbox-policy` stays mounted: it owns the per-session mode and workspace root.
Retention itself stays with `dsh-spill-policy` and `dsh-output-retention`, which
reach this backend through the one-method `ctx.spillStore` seam.

### Why spill needed replacing

`dsh-spill-policy` truncates a result over its token budget, `dsh-spill-local`
writes the full text to disk, and the model is told:

> `... Full formatted result stored at: <locator>. Use read with offset/limit, or grep this path to search within it.`

The stock backend's locator is the artifact's absolute **host** path under the OS
temp directory. Two things follow under a confinement that never discloses a host
path: the locator names no mount, so the `read` the notice promises is refused,
and a host path is written into the session log. `spill-bwrap` writes the same
bytes and reports `/spill/...`, which the mount table resolves and a confined
process reads at the same path.

The two fences answer different questions and deliberately disagree. Inside the
sandbox, a shell can read `/etc` and `/usr` because the system roots are bound
read-only there — a shell that cannot read `/etc` cannot start. The file tools
are fenced to the mounts and refuse those same paths, so `bash -c 'cat
/etc/passwd'` works while `read /etc/passwd` and `grep /` do not. A link inside
the workspace pointing at `/etc` is refused by the tools for the same reason,
even though a confined process follows it.

## The virtual namespace

The model names files in a virtual namespace whose top level holds only the
mounted roots — `/workspace`, `/sessions`, `/attachments`, `/spill`, and any
extra root an operator adds. One recursive walk maps a virtual path to a host
path, and a segment it cannot place refuses the whole call:

```
map(v):
    if v == '/':                     return FAKE_ROOT, '/'
    dir, name = v
    host, vdir = map(dir)
    if name == '.':                  return host, vdir
    if name == '..':                 return map(dirname(vdir))
    if host == FAKE_ROOT:            return the mount named '/' + name, or refuse
    file = host + '/' + name
    if file is a symlink:            return map(link target under vdir)
    return file, vdir + '/' + name
```

Three properties follow, and they are the reason there is no second containment
check to forget:

- **Containment is structural.** Every host path is a mount's host directory
  plus virtual segments, so nothing outside a mount is expressible. An alias
  such as `ln -s /real/workspace /sbin/ws` helps nobody: `/sbin/ws/x` names no
  mount, and the host path behind it is not under one either.
- **`..` acts on the mapped parent.** `/workspace/link/..` lands at the parent of
  what `link` resolves to, exactly as the kernel does, not at the parent of the
  text.
- **A symlink target is read in the virtual namespace**, because that is the
  namespace the process that wrote the link could see. A link to `/etc` becomes
  the virtual `/etc`, whose top-level name is not a mount, so it is refused
  rather than followed out. A link whose target is a host path is refused for
  the same reason — and this is what keeps the two views of the same directory
  identical, since such a link is dangling under `bash` as well.

What the model is shown is the canonical virtual path: `/workspace/a/../b`,
`/workspace/link/b`, and `/workspace/b` all report `/workspace/b`.

A host path handed in by the harness is converted through the mount table when a
mount covers it, and otherwise read as a virtual path — which can only succeed
if it names a mount. The rule covers every path-taking tool: `ctx.fs.resolve`
fences `read`, `read_image`, `write`, `edit`, `str_replace_editor`, and
`present`, while `guard-bwrap` applies the same walk to `grep`, `glob`, and
`lsp`, which do not resolve through `ctx.fs`.

Because the tools read symlink targets the way the sandbox does, the two views
of the workspace agree link for link:

| link target text | `bash` inside | file tools |
|---|---|---|
| `/workspace/src/a.txt` | resolves | resolves |
| `src/a.txt` | resolves | resolves |
| `<the real workspace>/src/a.txt` | dangling — no such path inside | refused |
| `/etc/passwd` | resolves to the read-only bind | refused |

### The terminal tools

`terminal_open` and `terminal_send` are confined too. `terminal-bash` builds its
argv and calls `ctx.sandbox.confine()` before allocating the PTY, so the shell
inside the terminal is the same `bwrap` invocation `bash` gets, with the same
workspace, HOME, masked homes, and stores. `danger-full-access` is the exception,
as everywhere else: that mode returns the bare argv.

A PTY driven through this profile was measured against the stock provider's:

| what a shell sees | stock provider | this package |
|---|---|---|
| `test -t 0` (is a tty) | yes | yes |
| `open /dev/tty` | yes | yes |
| `open /dev/ptmx` | yes | yes |
| job control (`jobs`, `kill %1`) | works | works |
| Ctrl-C stops the foreground job, shell survives | yes | yes |
| `tty` (`ttyname`) | `/dev/console` | `/dev/console` |
| `ls /dev/pts` | `ptmx` | `ptmx` |
| `pwd` | the host workspace path | `/workspace` |

### A shell's `workdir`

`bash` takes a `workdir` argument. Under `bwrap-sandbox` alone it was silently
ignored: `confine()` receives argv and policy and never the requested cwd, and
bubblewrap discards the spawn cwd — with no `--chdir` it chdirs to `$HOME`, and
to `/` when `$HOME` does not exist inside — so every command ran in `/workspace`
whatever was asked for.

`bash-bwrap` closes that. It extends the stock executor and overrides
`executeArgv`, which the local executor documents as the subclass hook for
replacing an execution boundary's argv, and which `execute` reaches through
`this`. The override:

- maps the requested directory through the mount table — a host path, which is
  what the tool layer resolves a relative one to, and `/workspace/...`, which is
  how the model names paths everywhere else;
- replaces the profile's `--chdir` value rather than adding a second option,
  because bubblewrap warns on stderr for a duplicate and this provider reads any
  `bwrap: ` line as a runner failure;
- re-anchors the spawn at the workspace root on a copy of the spec, so a virtual
  `workdir` cannot make the host-side spawn fail;
- refuses a directory that no mount covers, or that does not exist, rather than
  running somewhere else.

`pwsh` keeps the old behaviour: `pwsh-sandbox` calls `confine()` the same way and
this executor does not cover it.

## The sandbox profile

For each `ctx.sandbox.confine()` call the provider builds:

```
bwrap
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64
  --ro-bind /bin /bin --ro-bind /sbin /sbin --ro-bind /etc /etc --ro-bind /opt /opt
  --tmpfs /home --tmpfs /root                    # every home directory is masked
  --ro-bind <DSH_HOME>/sessions    /sessions
  --ro-bind <DSH_HOME>/attachments /attachments
  --ro-bind <DSH_HOME>/spill       /spill
  --tmpfs /tmp
  --bind   <workspace> /workspace                # --ro-bind under read-only
  --chdir  /workspace
  --setenv HOME /workspace
  --unsetenv DSH_HOME --unsetenv DSH_PROFILE_DIR
  --dev /dev --unshare-pid --proc /proc --die-with-parent
  -- <the caller's argv>
```

Two ordering facts make this work, both verified against bubblewrap 0.12.0:

- Mounts apply in argv order and a later mount replaces an earlier one at the
  same path, so the masking `--tmpfs` entries must follow the system binds and
  the workspace bind must follow the masking of its own ancestors.
- Bubblewrap resolves a bind **source** in the host namespace, so
  `--ro-bind <DSH_HOME>/sessions /sessions` still works when `<DSH_HOME>` lives
  under the masked `/home`. The store is reachable at `/sessions`; `/home` stays
  empty.

The three stores are bound read-only on purpose. The harness writes them from
outside the sandbox, and a confined process needs to read a spilled result,
never to forge or delete one.

`--chdir` re-anchors the child. The caller spawns with its own cwd — the host
workspace path, applied before bubblewrap builds the namespace — so without it
the child would start in a directory that does not exist inside.

## Configuration

```yaml
- id: bwrap-sandbox
  name: 'dsh-bwrap-sandbox/sandbox'
  config:
    systemReadOnlyRoots: ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/opt']
    maskedRoots: ['/home', '/root']
    sessionsRoot: ''          # default: $DSH_HOME/sessions
    attachmentsRoot: ''       # default: $DSH_HOME/attachments
    spillRoot: ''             # default: $DSH_HOME/spill
    privateTmp: true
    dropEnv: ['DSH_HOME', 'DSH_PROFILE_DIR']
```

| Field | Default | Meaning |
|---|---|---|
| `systemReadOnlyRoots` | `/usr`, `/lib`, `/lib64`, `/bin`, `/sbin`, `/etc`, `/opt` | Host directories bound read-only under their own path. A host that needs another root (`/nix`, `/snap`, a toolchain prefix) adds it here; a missing entry makes commands that touch it fail. |
| `maskedRoots` | `/home`, `/root` | Directories replaced by an empty tmpfs. Writable but ephemeral: no host data is readable and nothing survives the process. |
| `sessionsRoot` | `$DSH_HOME/sessions` | Host session-log directory, exposed read-only at `/sessions`. Set to a non-empty value to override; the empty default resolves `$DSH_HOME`. |
| `attachmentsRoot` | `$DSH_HOME/attachments` | Host attachment store, exposed read-only at `/attachments`. |
| `spillRoot` | `$DSH_HOME/spill` | Host spill directory, exposed read-only at `/spill`. Must match the `spillRoot` of the other three rows. |
| `privateTmp` | `true` | Mount a private writable `/tmp`. |
| `dropEnv` | `DSH_HOME`, `DSH_PROFILE_DIR` | Environment names removed from every confined process, because their values name host paths. |

`fs-bwrap` takes the local backend's own config (`cwd`, `diffBasisMaxBytes`) plus
the four mount fields below. `guard-bwrap` and `spill-bwrap` take the same four,
and all four rows must agree — they are separate plugins with separate configs,
and a value set on one has no effect on the others. A `spillRoot` that disagrees
is the sharpest case: `spill-bwrap` builds a `/spill/...` locator for one host
directory and the other rows resolve it to another.

```yaml
- id: fs-bwrap
  name: 'dsh-bwrap-sandbox/fs'
  config:
    sessionsRoot: ''              # default: $DSH_HOME/sessions
    attachmentsRoot: ''           # default: $DSH_HOME/attachments
    spillRoot: ''                 # default: $DSH_HOME/spill
    additionalReadOnlyRoots: []

- id: guard-bwrap
  name: 'dsh-bwrap-sandbox/guard'
  config:
    sessionsRoot: ''              # keep identical to the fs-bwrap row
    attachmentsRoot: ''           # keep identical to the fs-bwrap row
    spillRoot: ''                 # keep identical to the fs-bwrap row
    additionalReadOnlyRoots: []

- id: spill-bwrap
  name: 'dsh-bwrap-sandbox/spill'
  config:
    spillRoot: ''                 # keep identical to the fs-bwrap row
    cleanupPeriodDays: 30
```

| Field | Default | Meaning |
|---|---|---|
| `sessionsRoot` | `$DSH_HOME/sessions` | Host session-log directory, exposed read-only at `/sessions`. |
| `attachmentsRoot` | `$DSH_HOME/attachments` | Host attachment store, exposed read-only at `/attachments`. |
| `spillRoot` | `$DSH_HOME/spill` | Host directory the artifacts are written to and read from, exposed read-only at `/spill`. |
| `additionalReadOnlyRoots` | `[]` | Extra host directories mounted as further virtual roots under their own path. Each entry must be a single top-level directory (`/tmp`, not `/var/tmp`), because a virtual mount is one name; anything else fails at load rather than becoming an unreachable directory. |
| `cleanupPeriodDays` | `30` | Age at which `spill-bwrap`'s one startup sweep reclaims an artifact and prunes the session directory it emptied. `0` disables the sweep. Retention is deliberate: a resumed or forked session may still reference an older locator until it ages out. |

`guard-bwrap` also owns which tools it fences, because the mounted tool set varies
by deployment:

```yaml
- id: guard-bwrap
  name: 'dsh-bwrap-sandbox/guard'
  config:
    pathArguments:                # tool → the argument naming one path
      read: file_path
      read_image: file_path
      write: file_path
      edit: file_path
      str_replace_editor: path
      grep: path
      glob: path
      lsp: file_path
      notebook_edit: file_path    # a tool this deployment adds
    pathArrayArguments:           # tool → the argument holding `{ path }` entries
      present: files
```

| Field | Default | Meaning |
|---|---|---|
| `pathArguments` | the eight shipped entries: `read`, `read_image`, `write`, `edit`, `str_replace_editor` → `file_path`/`path`, `grep` and `glob` → `path`, `lsp` → `file_path` | Tools taking one path. || `pathArrayArguments` | `present` → `files` | Tools taking a list of `{ path }` entries. |

The value is the **whole table**, not an overlay: the shipped table is the field's
default, so omitting the field keeps it and setting the field replaces it.

`--dump-config` is where the template comes from. It prints the composed YAML
layers and expands no schema, so a row prints the `config:` a layer wrote and
nothing more — which is why the bundle's patch carries these two tables rather
than relying on the plugin's default to show them:

```yaml
- id: guard-bwrap
  name: dsh-bwrap-sandbox/guard
  config:
    pathArguments:
      read: file_path
      read_image: file_path
      write: file_path
      edit: file_path
      str_replace_editor: path
      grep: path
      glob: path
      lsp: file_path
    pathArrayArguments:
      present: files
```

That block is **generated**, not written by hand: `npm run sync:patch` renders it
from `DEFAULT_PATH_ARGUMENTS` and `DEFAULT_PATH_ARRAY_ARGUMENTS`, the same
constants the schema defaults to, so the two cannot disagree. `npm test` fails
when the committed block differs from what the script would write, which is the
only thing standing between a changed table and a stale template an operator
would copy.

A patch targets an entry by id and assigns its keys, so a `config:` here replaces
the whole block rather than merging into it. Copy the whole table.

The other three rows carry no `config:` on purpose: their defaults are
environment-derived (`$DSH_HOME` for the stores, the process working directory
for `fs-bwrap`'s `cwd`), and pinning those into a patch would freeze one host's
paths into the bundle. `--dump-config-schema` prints every default including
those, because it embeds each plugin's config schema:

```sh
dsh --profile <name> --dump-config-schema | jq '.$defs[] | select(.anyOf[0].properties.pathArguments)'
```

The consequence is worth stating plainly. A tool left out of `pathArguments` is a
tool the guard does not inspect, so writing one entry with the intent of *adding*
a tool instead replaces all eight — and `grep`, `glob`, and `lsp` stop being
fenced. Those three are the ones only this plugin covers; the rest are also
fenced by `fs-bwrap`, which this field does not affect.

A blank tool name, a blank argument, or one tool in both tables fails at load. A
wrong argument name cannot be caught, and means the call carries nothing to
inspect — see the limitations below.

## Installing

```sh
dsh plugin --profile <name> add /path/to/dsh-bwrap-sandbox
dsh --profile <name> --dump-config | grep -A2 'dsh-bwrap-sandbox'
```

`--dump-config` is the way to confirm the rows landed and to see which bundle
patched what, and it prints the guard template to copy.

The bundle layer must sort **after** the application layer, because it disables
rows (`sandbox`, `fs-sandbox`, `spill-local`) that `dsh-base` inserts. Adding it
last through `dsh plugin` does that.

## Verification

Unit tests (`npm test`) pin the profile ordering and the mapping: a virtual, a
host, and a relative path reaching the same file; an alias outside the mounts
refused; a link to `/etc` and a link holding a host path both refused; a link
holding `/workspace/...` and a relative link both followed; `/workspace/../etc/passwd`
refused; `..` after a symlink landing at the target's parent; a symlink loop
refused; an extra root reached under its own name only. The profile itself was
exercised end-to-end against real bubblewrap: under `workspace-write`, `/home`
lists empty, `~/.bashrc` fails with `ENOENT`, the workspace reads and writes,
`/usr` writes report `read-only file system`, `/sessions` lists the real session
logs, `DSH_HOME` is unset, `/tmp` is writable, and `pwd`/`HOME` are `/workspace`;
under `read-only` the workspace write reports `read-only file system` and
everything else is unchanged. The link table above was measured, not assumed:
for each of its four rows, `bash` inside the sandbox and `mapPath` outside it
were run against the same link and agree. Spill retrieval was measured the same
way: one `saveText` produced a `/spill/...` locator, `mapPath` resolved it to the
file that was written, `bash` read the same locator inside the sandbox and got
the same bytes, and a write through it reported `read-only file system`. The
guard's argument tables are covered from both ends: the merge is asserted
against the shipped tables, and each of adding, overriding, and removing a tool
is exercised through a real registered guard.

## Known limitations

- **Linux only, and fail-closed.** Bubblewrap is the sole backend. On another
  platform, or a host where `bwrap` cannot build the profile, `confine()` throws
  `SANDBOX_UNAVAILABLE` and the command does not run. This replaces the
  platform-chain provider, so the Landlock, Seatbelt, and Windows ACL backends
  are not reachable in this composition.
- **`danger-full-access` bypasses the sandbox.** The mode's consumers spawn
  their own argv and never call `ctx.sandbox.confine()`. The filesystem fence is
  independent and still applies, but a shell in that mode is unconfined.
- **`pwsh` still ignores `workdir`**, landing in `/workspace` whatever was asked
  for. `terminal-bash` and PTC `run_code` have no such argument, so they are
  unaffected. Closing that gap needs the requested cwd to reach `confine()`, a
  change in the harness packages rather than here.
- **The filesystem fence is a policy check, not a kernel boundary.** Like the
  stock `dsh-fs-sandbox`, it maps and contains in trusted code and accepts a
  narrow map-to-syscall window. Kernel-grade isolation of running code is the
  sandbox provider's job.
- **The filesystem tools cannot write outside the workspace**, including `/tmp`,
  even though bash can. Write permission is `sandbox-policy`'s, not this
  package's: the stores are outside its writable roots, and the profile binds
  them read-only. An extra root added here stays read-only for the tools.
- **A replaced guard table covers only what it names.** The shipped table is the
  default, so nothing merges in: a `pathArguments` that omits `grep`, `glob`, or
  `lsp` stops fencing them, and this plugin is the only fence over those three.
  Copy the table from `--dump-config` or from this README rather than writing it
  from memory.
- **A tool the operator adds to the guard is fenced by path only.** The guard
  reads the argument the config names; it cannot know what the tool does with it.
  An entry that names the wrong argument carries nothing to inspect and therefore
  fences nothing, which is why new entries are worth testing against a real call.
- **`spillRoot` must be configured identically on all four rows.** They are
  separate plugins; nothing checks the agreement. A mismatch makes `spill-bwrap`
  write to one directory while `read` resolves the locator to another, which
  fails as a missing file rather than as a denial.
- **Spill artifacts accumulate for `cleanupPeriodDays`.** The sweep runs once at
  activation, so a long-running process does not reclaim while it runs, and
  `cleanupPeriodDays: 0` disables reclamation entirely. The files live under
  `$DSH_HOME/spill` and can be removed by hand.
- **Tools outside both fences.** `mcp__*` servers, externally spawned subagent
  CLIs (`subagent-claude-code`, `subagent-codex`, `subagent-acp`,
  `subagent-dsh-sdk`), `plugin_manager`, and browser/computer-use plugins are
  plain child processes that neither provider sees. Compose them out if they
  matter.
- **A link whose target names a host path does not resolve for the tools**, just
  as it does not resolve under `bash`. A workspace whose links were written from
  outside the sandbox with absolute host targets — some package managers do
  this — is readable at the real paths but not through those links. Repair them
  by making the targets relative or spelling them `/workspace/...`, which then
  works in both views.
- **A shell inside the sandbox cannot name its own terminal.** `--dev /dev`
  mounts a fresh devpts instance, so the harness's pty slave number is not in
  `/dev/pts` and `ttyname()` falls back to `/dev/console`. Everything a terminal
  program actually needs still works — `isatty`, `/dev/tty`, `/dev/ptmx`, job
  control — and the stock provider behaves identically, so this is bubblewrap's
  behaviour rather than this composition's. `--dev-bind /dev /dev` fixes the name
  but exposes every host terminal, which is why it is not the default.
- **An extra mount root reaches the file tools only.** `additionalReadOnlyRoots`
  is read by `fs-bwrap` and `guard-bwrap`; `bwrap-sandbox` does not bind those
  directories, so a confined process cannot see them. That is the safe
direction — the tools learn about a tree the sandbox already cannot reach —
  but it means the two views of the filesystem differ, and binding `/tmp`
  there would also override its private-tmp mask.
- **The real workspace path is still disclosed by `sandbox-policy`.** Its
  runtime-context snapshot names the recorded session workspace. Suppressing it
  wholesale (`ctx.systemPrompt.suppressRuntimeContext()`) would also drop the
  approval and delegation contexts, so this package leaves it alone; the leak
  disappears only if that contribution stops naming the root.
- **A user interface that opens files must translate `/workspace/...` back.**
  The client already knows the session's real cwd, so the mapping is mechanical,
  but a card that feeds the displayed path straight to a file opener will not
  find it.

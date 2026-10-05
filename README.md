# dsh-bwrap-sandbox

Bubblewrap confinement and workspace-fenced file tools for DeepSeek Harness.

Every confined process sees the session workspace as `/workspace` and every home
directory as an empty, ephemeral directory. The session's own working directory
is `/workspace` too — the harness asks the filesystem provider how its execution
world spells a path — so the model never receives a host path and cannot name
one: file tools report `/workspace/...`, the shell's `pwd` is `/workspace`,
spilled tool output is addressed as `/spill/...`, a host-spelled tool argument is
refused, and the environment names that would carry a host path are dropped.

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

`sandbox-policy` stays mounted: it owns the per-session mode and workspace root,
and the bundle restates the root in the execution world's spelling. It is not a
row this bundle replaces.

The patch also disables `tool-fs-search`, so the session has no `grep` and no
`glob`: both spawn the packaged ripgrep on the harness host and hand it the
model's path, which names a directory that exists only inside the sandbox. See
[why it cannot be fixed from here](#search-tools-are-disabled).
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

The two fences answer different questions, so they disagree on what they say
about the same path. Inside the sandbox a shell can read `/etc` and `/usr`,
because the system roots are bound read-only there — a shell that cannot read
`/etc` cannot start. The file tools are narrowed to the mounts, so `bash -c 'cat
/etc/passwd'` works while `read /etc/passwd` and `grep /` fail.

What they say is **absent**, not denied: `ctx.fs` answers `FS_NOT_FOUND` and the
guard answers `cannot access "<path>": not found`. That is literally what a
confined process sees at a masked home directory or at a name the profile never
mounts, and it is the answer a caller probing for an optional file can act on.
Reporting a boundary refusal instead makes project-root discovery and skill
loading treat an ordinary absence as a broken backend, which is how an ancestor
`.git` probe used to abort AGENTS.md loading.

## The virtual namespace

The model names files in a virtual namespace whose top level holds only the
mounted roots — `/workspace`, `/sessions`, `/attachments`, `/spill`, `/agents`,
`/skills`, `/AGENTS.md`, and any extra root an operator adds. One recursive walk
maps a virtual path to a host path, and a segment it cannot place fails the call
as **not found**:

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

The namespace has one spelling, and no host path is a name in it. A session's
working directory is the one the filesystem provider reports through
`processPath` — `/workspace` here — so the harness itself spells paths the way
the sandbox does: the persona's `{{cwd}}`, the runtime-context policy line, the
instruction loaders, the skill loaders, and every tool argument. A host path in
a **tool argument** is refused outright, with the same answer any path the
sandbox does not have gets:

```text
read file_path=/home/deepseek/workspace/notes.md
→ cannot access "/home/deepseek/workspace/notes.md": not found
read file_path=/etc/passwd
→ cannot access "/etc/passwd": not found
```

One answer, because a distinct one would be an oracle. Naming the sandbox's path
for the same file, or saying the argument was a host spelling at all, would
confirm which guess named a real host file and where that file lives in the
namespace — and it would do so in a message the session log keeps, which can be
exported or quoted back by the model. The reply repeats the caller's own argument
and nothing more.

`ctx.fs.resolve` and `ctx.fs.lstat` fence `read`, `read_image`, `write`, `edit`,
`str_replace_editor`, and `present`; `guard-bwrap` applies the same walk and the
host-spelling rule to `grep`, `glob`, and `lsp`, which do not resolve through
`ctx.fs`, and to the directory argument of `bash`, `pwsh`, and `terminal`, whose
providers would otherwise absorb a host spelling.

The one host string still honored is a **mount root**: the deployment's own
directory, written in configuration, which anchors a relative path for a session
recorded before the namespace existed. Nothing beneath such a root is a name,
and a path under no root is `not found` like any other path the sandbox does not
have.

**The launcher has to spell the session cwd this way.** The stock headless runner
derives it from `fs.processPath(await fs.resolve('.'))`, which is `/workspace`
here. An app that records a host path instead — a custom launcher, an SDK call
passing `meta: { cwd: process.cwd() }` — leaves every loader that joins the
session cwd (project `AGENTS.md`, project skill roots, relative tool paths)
asking for host paths, which this bundle refuses by design. The symptom is
silent: no project instructions and no project skills, with the user-level roots
still working. `npm run inspect:skills` reports which of the two it is:

```sh
node scripts/inspect-session-skills.mjs ~/.dsh/sessions/…/session.v4.jsonl.zstd --name <skill>
```

An existing session cannot be repaired — its header already carries the host
path — so either the launcher is fixed and a new session starts, or the skill
lives in a user-level root (`~/.agents/skills/<name>/` seen at `/agents/skills`,
`$DSH_HOME/skills/<name>/` seen at `/skills`), which is mounted regardless of the
session cwd.

A directory listing is part of the same rule. `listDir` reports every child as
`<listed directory>/<name>` — the spelling a caller can pass back to any other
method — instead of the host path the local backend resolves for it, because
`str_replace_editor`'s directory view prints those paths verbatim. A child whose
resolved target lies outside every mount is omitted rather than listed with an
unresolvable target, since that target re-enters the backend for follow-up
operations.

Because the tools read symlink targets the way the sandbox does, the two views
of the workspace agree link for link:

| link target text | `bash` inside | file tools |
|---|---|---|
| `/workspace/src/a.txt` | resolves | resolves |
| `src/a.txt` | resolves | resolves |
| `<the real workspace>/src/a.txt` | dangling — no such path inside | not found |
| `/etc/passwd` | resolves to the read-only bind | not found |

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

### Search tools are disabled

`grep` and `glob` come from `dsh-tool-fs-search`, which spawns the packaged
ripgrep **on the harness host** and passes the model's path to it unchanged. That
makes the host its execution world while this bundle's is the sandbox, and no
path satisfies both: the model knows only `/workspace/...`, which the host does
not have, and the tool's default workdir is the session cwd — `/workspace` here
as well — so even a call with no path fails. The guard still fences their
argument, so no host path leaks; the search simply cannot run.

Nothing in this bundle can fix that, because the argument never passes through a
point a plugin owns: it goes straight into the tool's own subprocess. The patch
therefore disables the `tool-fs-search` row, which removes both tools from the
model's tool list instead of offering two that always fail. `bash` searches the
same tree from inside the sandbox, where the path it is given exists.

Restoring them means making them run ripgrep inside the sandbox: spawn it
through `ctx.shell` (or confine `ctx.subprocess`), bind the ripgrep binary into
the profile, and resolve the model's path with `ctx.fs.processPath` — the seam's
answer for "a path a subprocess in this execution world can open". That is a
change in the harness packages, not here.

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
  --ro-bind <DSH_AGENTS_HOME>      /agents        # default: ~/.agents
  --ro-bind <DSH_HOME>/skills      /skills
  --ro-bind <DSH_HOME>/AGENTS.md   /AGENTS.md
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

The read-only binds are on purpose. The harness writes those directories from
outside the sandbox, and a confined process needs to read a spilled result, a
skill, or the user-global instructions — never to forge or delete one. Each of
them is bound only when its host source exists, because bubblewrap refuses a
profile whose bind source is missing and that would take the workspace down with
it: a fresh `$DSH_HOME`, an absent `~/.agents`, and a user who never wrote
`AGENTS.md` are all normal states. The tool side reports the same absence as
`FS_NOT_FOUND`.

A mount listed in `writableRoots` is bound with `--bind` instead, and the
`fs-bwrap` row admits writes inside it. Everything else stays read-only, and
`read-only` mode still denies every mutation. Configure the same list on both
rows: a mount writable for the profile but fenced for the tools — or the reverse
— fails as a denial or as `read-only file system`, depending on which gate ran
first.

The `/agents`, `/skills`, and `/AGENTS.md` mounts exist for the harness itself.
`skill-filesystem` reads its `user-agents` and `user-dsh` skills through
`ctx.fs`, and `agent-instructions` reads one user-global file, so without them
those inputs are silently invisible — the loaders catch the error and report no
skills or no user-global instructions rather than failing. `/AGENTS.md` is one
file, not `$DSH_HOME`: that directory also holds credentials.

The bundle therefore configures both loader rows with **namespace spellings**,
not host directories, because a host directory is not a name this session has:

```yaml
- id: agent-instructions
  config:
    maxBytes: 65536
    projectRootMarkers: []
    dshHome: /          # so the user-global file it joins is /AGENTS.md

- id: skill-filesystem
  config:
    dshHome: /          # so its user-dsh root is /skills
    agentsHome: /agents # so its user-agents root is /agents/skills
```

Both loaders join their configured root with a name and then join each child
they list onto that root, so the root has to be a namespace path for the
children to be too. Both report nothing when a path resolves to nothing: a host
root here shows up as an empty skill catalog and a missing user-global
instruction block, never as an error.

The same rule reaches `sandbox-policy`, whose contract spells its fallback root
in the execution world ("preserve execution-world spelling; enforcing providers
resolve filesystem identity on their host"). The bundle restates that root as
`/workspace`, so the policy line the model reads names the virtual workspace
rather than the deployment's home directory. Agent sessions resolve their own
cwd, which `fs-bwrap` already reports as `/workspace`.

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
    # Further read-only mounts, as <name in the namespace>: <host directory>.
    # additionalReadOnlyRoots:
    #   my_files: /home/deepseek/my_files   # -> /my_files
    workspace: ''             # default: the process working directory
    sessionsRoot: ''          # default: $DSH_HOME/sessions
    attachmentsRoot: ''       # default: $DSH_HOME/attachments
    spillRoot: ''             # default: $DSH_HOME/spill
    agentsHome: ''            # default: $DSH_AGENTS_HOME or ~/.agents
    skillsRoot: ''            # default: $DSH_HOME/skills
    userInstructionsFile: ''  # default: $DSH_HOME/AGENTS.md
    writableRoots: []         # virtual mounts the agent may write, e.g. ['/agents']
    privateTmp: true
    dropEnv: ['DSH_HOME', 'DSH_PROFILE_DIR']
```

| Field | Default | Meaning |
|---|---|---|
| `systemReadOnlyRoots` | `/usr`, `/lib`, `/lib64`, `/bin`, `/sbin`, `/etc`, `/opt` | Host directories bound read-only under their own path. A host that needs another root (`/nix`, `/snap`, a toolchain prefix) adds it here; a missing entry makes commands that touch it fail. |
| `maskedRoots` | `/home`, `/root` | Directories replaced by an empty tmpfs. Writable but ephemeral: no host data is readable and nothing survives the process. |
| `workspace` | the process working directory | Host workspace directory bound at `/workspace`. The harness spells the workspace the way the execution world does, so the policy this row receives names `/workspace`; a policy naming any other root fails closed rather than confining against the wrong directory. |
| `sessionsRoot` | `$DSH_HOME/sessions` | Host session-log directory, exposed read-only at `/sessions`. Set to a non-empty value to override; the empty default resolves `$DSH_HOME`. |
| `attachmentsRoot` | `$DSH_HOME/attachments` | Host attachment store, exposed read-only at `/attachments`. |
| `spillRoot` | `$DSH_HOME/spill` | Host spill directory, exposed read-only at `/spill`. Must match the `spillRoot` of the other rows. |
| `agentsHome` | `$DSH_AGENTS_HOME` or `~/.agents` | Host user-level agents home, exposed read-only at `/agents`. Must match the `agentsHome` of `skill-filesystem`, whose `user-agents` skills are read from `<agentsHome>/skills`. |
| `skillsRoot` | `$DSH_HOME/skills` | Host user-level DSH skill root, exposed read-only at `/skills`. Must match the `dshHome` of `skill-filesystem`, which reads `user-dsh` skills from `<dshHome>/skills`. |
| `userInstructionsFile` | `$DSH_HOME/AGENTS.md` | Host user-global instruction file, exposed read-only at `/AGENTS.md`, the single path `agent-instructions` loads user-global instructions from. It usually does not exist, and then it is not bound and reads as absent. |
| `writableRoots` | `[]` | Virtual mounts bound writable instead of read-only, e.g. `['/agents']`. Each entry must name a mount, and an unknown name fails at load. Must match the `fs-bwrap` row; see [Writable mounts](#writable-mounts). |
| `privateTmp` | `true` | Mount a private writable `/tmp`. |
| `dropEnv` | `DSH_HOME`, `DSH_PROFILE_DIR` | Environment names removed from every confined process, because their values name host paths. |

`fs-bwrap` takes the local backend's own config (`cwd`, `diffBasisMaxBytes`) plus
the mount fields below; `workspace` names the host workspace directory the mount
table anchors at and `processPath` reports as `/workspace`. Empty `workspace`
falls back to the inherited `cwd`, which is the same directory and stays the base
for a relative path no caller anchored. `guard-bwrap` takes the same mount fields
plus `workspace`, its host anchor, and
`spill-bwrap` takes `spillRoot`, which must match theirs. They are separate
plugins with separate configs, so a value set on one has no effect on the others.
A `spillRoot` that disagrees is the sharpest case: `spill-bwrap` builds a
`/spill/...` locator for one host directory and the other rows resolve it to
another. The same hazard applies to `agentsHome`, `skillsRoot`, and
`userInstructionsFile`, whose mount sources the loader rows read through
`ctx.fs` and whose configured roots are the namespace spellings above — a host
spelling in either place is invisible: the loader catches the unresolvable path
and answers "no skills" or "no user-global instructions", so a mismatch here
surfaces as something missing from the prompt rather than as an error.

```yaml
- id: fs-bwrap
  name: 'dsh-bwrap-sandbox/fs'
  config:
    workspace: ''                 # default: the inherited cwd, keep identical to the bwrap-sandbox row
    sessionsRoot: ''              # default: $DSH_HOME/sessions
    attachmentsRoot: ''           # default: $DSH_HOME/attachments
    spillRoot: ''                 # default: $DSH_HOME/spill
    agentsHome: ''                # default: $DSH_AGENTS_HOME or ~/.agents
    skillsRoot: ''                # default: $DSH_HOME/skills
    userInstructionsFile: ''      # default: $DSH_HOME/AGENTS.md
    writableRoots: []             # keep identical to the bwrap-sandbox row
    additionalReadOnlyRoots: {}   # keep identical to the bwrap-sandbox row

- id: guard-bwrap
  name: 'dsh-bwrap-sandbox/guard'
  config:
    workspace: ''                 # keep identical to the bwrap-sandbox row
    sessionsRoot: ''              # keep identical to the fs-bwrap row
    attachmentsRoot: ''           # keep identical to the fs-bwrap row
    spillRoot: ''                 # keep identical to the fs-bwrap row
    agentsHome: ''                # keep identical to the fs-bwrap row
    skillsRoot: ''                # keep identical to the fs-bwrap row
    userInstructionsFile: ''      # keep identical to the fs-bwrap row
    writableRoots: []             # validated here, acted on by fs-bwrap
    additionalReadOnlyRoots: {}   # keep identical to the bwrap-sandbox row

- id: spill-bwrap
  name: 'dsh-bwrap-sandbox/spill'
  config:
    spillRoot: ''                 # keep identical to the fs-bwrap row
    cleanupPeriodDays: 30
```

| Field | Default | Meaning |
|---|---|---|
| `workspace` | the process working directory | Host directory the guard's mount table anchors at. It reads this instead of the session cwd, which is an execution-world path. |
| `sessionsRoot` | `$DSH_HOME/sessions` | Host session-log directory, exposed read-only at `/sessions`. |
| `attachmentsRoot` | `$DSH_HOME/attachments` | Host attachment store, exposed read-only at `/attachments`. |
| `spillRoot` | `$DSH_HOME/spill` | Host directory the artifacts are written to and read from, exposed read-only at `/spill`. |
| `agentsHome` | `$DSH_AGENTS_HOME` or `~/.agents` | Host user-level agents home, exposed read-only at `/agents`. |
| `skillsRoot` | `$DSH_HOME/skills` | Host user-level DSH skill root, exposed read-only at `/skills`. |
| `userInstructionsFile` | `$DSH_HOME/AGENTS.md` | Host user-global instruction file, exposed read-only at `/AGENTS.md`. |
| `writableRoots` | `[]` | Virtual mounts the file tools may write inside, e.g. `['/agents']`. Only `fs-bwrap` acts on it; the other rows validate the name so a typo fails at load. |
| `additionalReadOnlyRoots` | `{}` | Further host directories exposed read-only, as `{ <name>: <host directory> }`. The key is the mount point and the value is the host directory behind it, so a nested host directory gets a name of the operator's choosing: `my_files: /home/deepseek/my_files` exposes it at `/my_files`, and the host path itself stays unnameable. The key is one top-level segment, with or without its leading slash; a nested key, a non-absolute host directory, or a name a built-in mount or `/tmp` already has fails at load. |
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
      bash: workdir
      pwsh: workdir
      terminal: cwd
      notebook_edit: file_path    # a tool this deployment adds
    pathArrayArguments:           # tool → the argument holding `{ path }` entries
      present: files
```

| Field | Default | Meaning |
|---|---|---|
| `pathArguments` | the eleven shipped entries: `read`, `read_image`, `write`, `edit` → `file_path`, `str_replace_editor`, `grep`, `glob` → `path`, `lsp` → `file_path`, `bash` and `pwsh` → `workdir`, `terminal` → `cwd` | Tools taking one path. |
| `pathArrayArguments` | `present` → `files` | Tools taking a list of `{ path }` entries. |

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
      bash: workdir
      pwsh: workdir
      terminal: cwd
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
a tool instead replaces all eleven — and `grep`, `glob`, and `lsp` stop being
fenced. Those three are the ones only this plugin covers; `read`, `read_image`,
`write`, `edit`, `str_replace_editor`, and `present` are also fenced by
`fs-bwrap`, which this field does not affect. `bash` and `pwsh` keep their
`workdir` resolved by the shell provider either way, and `terminal`'s `cwd` by
its own provider, so removing their entries stops the host-spelling refusal
without unconfining anything.

A blank tool name, a blank argument, or one tool in both tables fails at load. A
wrong argument name cannot be caught, and means the call carries nothing to
inspect — see the limitations below.

### Writable mounts

By default every mount outside the workspace is read-only in both fences. This
backend owns the whole writable set rather than delegating to the inherited
check, because that check compares a target's **host** path against roots derived
from the execution policy — and under this namespace the policy's workspace root
is the execution-world spelling (`/workspace`), which names no host directory.
The set is the workspace mount plus every mount named in `writableRoots`,
compared on the canonical host path after a fresh resolution that closes the gap
between the tool's own resolve and the write. A target outside it, and every
mutation under `read-only`, still fails with the stock `FS_SANDBOX_DENIED`
message. A
deployment that wants the agent to author a skill at the user level flips one
mount:

```yaml
- id: bwrap-sandbox
  config:
    writableRoots: ['/agents']

- id: fs-bwrap
  config:
    writableRoots: ['/agents']
```

Both rows are needed. `bwrap-sandbox` binds the mount read-write so a confined
process can write, and `fs-bwrap` admits the write through its policy fence:
`SandboxedFileSystem` permits a mutation only under the session workspace or a
platform temp area and no policy field widens that set, so a listed mount is
re-canonicalized and delegated past that one check. `read-only` mode still denies
every mutation, and every mount not listed keeps the inherited fence.

What the option decides: those directories are the instruction sources the agent
reads. `~/.agents/skills` and `$DSH_HOME/skills` are shared by every session on
the machine, and `/AGENTS.md` is the user-global instruction file itself, so a
session that writes them writes what later sessions will follow. Skill authoring
that does not need that reach already works: `skill-filesystem` also reads the
project roots `<workspace>/.dsh/skills` and `<workspace>/.agents/skills`, which
live inside the workspace, are writable, and are watched, so a skill written
during a session is picked up.

### Project-root discovery

The bundle also clears the instruction loader's root markers:

```yaml
- id: agent-instructions
  config:
    maxBytes: 65536
    projectRootMarkers: []
```

Discovery walks up from the session cwd probing `<dir>/.git`, then loads every
`AGENTS.md`/`CLAUDE.md` between that root and the cwd. Inside the fence there is
no ancestor project to find — the workspace mount is the whole visible project,
and the tools cannot read the ancestors — so those probes are answered as absent
and the walk would end at the workspace on its own. Clearing the markers stops
the probes and states the intent. The user-global file still loads, from the
`/AGENTS.md` mount. `maxBytes` is restated because a `config:` patch replaces
the whole block; keep it in step with the base bundle's row.

The prompt labels that file `~/.dsh/AGENTS.md`: `dsh-home-paths` never returns an
absolute home path, so the label cannot follow the mount. Its content is injected
at the start of the session, so nothing needs to read it by that name.

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

Unit tests (`npm test`) pin the profile ordering and the mapping: a virtual and a
relative path reaching the same file while its host spelling is `FS_NOT_FOUND`; an
alias outside the mounts reading as absent; a link to `/etc` and a link holding a
host path both reading as absent; a link
holding `/workspace/...` and a relative link both followed; `/workspace/../etc/passwd`
reading as absent; `..` after a symlink landing at the target's parent; a symlink loop
refused by the mapping; an extra root reached under its own name only; the
user-level agents home, skill root, and instruction file reachable under their
virtual names and refused under their host ones; a workdir that maps only when it
IS the configured root; and a bind source that does not exist skipped rather than
fatal. Four of them run the real
`@deepseek-ai/dsh-agent-instructions` loader against the real backend: root
discovery completes past an ancestor that has both a `.git` and its own
`AGENTS.md`, that ancestor's instructions do not load, the user-global file loads
from `/AGENTS.md`, and a missing user-global file is not an error. Reverting the
backend's `FS_NOT_FOUND` to a denial fails all of them with the original
`cannot access ".../.git"` abort. The profile itself was
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
A refused path is silent by design — it reads as `not found` — so the fence can
print what it refused and who named it. Setting `BWRAP_TRACE=1` writes one block
per refusal to stderr, with the first frames that reached the fence, and
`BWRAP_TRACE_RESOLVE=1` writes one line per *successful* resolution, because a
loader that found the wrong tree reports nothing at all:

```sh
BWRAP_TRACE=1 dsh --profile <name> "task"
BWRAP_TRACE_RESOLVE=1 dsh --profile <name> "task"
```

That is how the current wiring was checked. A whole session — skills, both
instruction files, the policy line, a confined `bash` call — produced exactly one
refusal, `/.git` from `skill-filesystem`'s upward project-root walk, which is a
virtual path at the namespace root and the walk's expected termination, and this
resolution list:

```text
/workspace/.dsh/skills                         /workspace/.dsh/skills/proj-dsh/SKILL.md
/workspace/.agents/skills                      /workspace/.agents/skills/proj-agents/SKILL.md
/skills                                        /skills/local/SKILL.md
/agents/skills                                 /agents/skills/demo/SKILL.md
/workspace/AGENTS.md                           /workspace/AGENTS.local.md
/AGENTS.md
```

No host path reached `ctx.fs`, and no host path was refused from a caller that
should have named a virtual one.

The skill catalog was measured the same way: a session whose `write` call created
`/workspace/.agents/skills/probe-skill/SKILL.md` emitted the `<available_skills>`
reminder twice — `demo, local, proj-agents, proj-dsh` before the write and
`demo, local, probe-skill, proj-agents, proj-dsh` after it — which is the
invalidation path working, and the same reminder never changes for a skill
created with `bash`.

`npm run inspect:skills` answers it by RUNNING the loader: it mounts the real
`dsh-skill` registry and the real `dsh-skill-filesystem` provider over this
bundle's real backend, asks for the catalog with the session's cwd, and prints
both the answer and every path the provider requested — including the refusals,
which the loader itself can only see as absence.

```sh
node scripts/inspect-session-skills.mjs ~/.dsh/sessions/…/session.v4.jsonl.zstd
```

The same probe with two cwds, against one deployment, is the whole diagnosis: a
session whose cwd is `/workspace` gets five skills and one refusal (`/.git`, the
project walk's end), while one whose cwd is a host path gets only the two
user-level skills and seven refusals — the project roots among them:

```text
REFUSED resolve /home/deepseek/workspace/.agents/skills  ->  FS_NOT_FOUND: cannot access …
```

An existing session cannot be repaired: its header already carries the host path,
so either the launcher is fixed and a new session starts, or the skill lives in a
user-level root (`~/.agents/skills/<name>/`, seen at `/agents/skills`, or
`$DSH_HOME/skills/<name>/`, seen at `/skills`), which is mounted regardless of the
session cwd.

The probe also prints the `<available_skills>` reminders the log recorded, which
is what tells the freshness question apart from the root question: a skill
created through `write` or `edit` appears in a later reminder, and one created
with `bash` does not.
## Known limitations

- **Linux only, and fail-closed.** Bubblewrap is the sole backend. On another
  platform, or a host where `bwrap` cannot build the profile, `confine()` throws
  `SANDBOX_UNAVAILABLE` and the command does not run. This replaces the
  platform-chain provider, so the Landlock, Seatbelt, and Windows ACL backends
  are not reachable in this composition: a host that refuses the profile — no
  unprivileged user namespaces, a container that blocks `unshare`, or a missing
  bind source — runs nothing rather than falling back to a weaker sandbox.
  Bubblewrap's own diagnostic is reported in the thrown error, in the log, and on
  stderr, together with the exact `bwrap …` command to reproduce:

  ```
  dsh-bwrap-sandbox: bwrap cannot build the sandbox profile on this host, so confined commands are refused.
    reason: bwrap: setting up uid map: Permission denied
    reproduce: bwrap --tmpfs /home ... --bind /the/workspace /workspace --chdir /workspace ... -- true
  ```

  `setting up uid map: Permission denied` is the common container and
  hardened-kernel failure. On a hardened host the knobs are
  `kernel.unprivileged_userns_clone` and
  `kernel.apparmor_restrict_unprivileged_userns` (`sysctl -w`); inside a
  container, `unshare` must be permitted (`--cap-add SYS_ADMIN` plus a seccomp
  profile that allows it), or `bwrap` installed setuid-root. Every bind source —
  the system roots included — is skipped when it does not exist, because a
  distribution without `/opt` or `/sbin` would otherwise take the whole workspace
  down with it.
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
  them read-only. An extra root added here stays read-only for the tools unless
  it is listed in `writableRoots`. The policy also allows the host temp areas,
  which no mount names — unless `$DSH_HOME` itself lives under one, in which case
  those stores are writable to the tools and only the profile's `--ro-bind`
  refuses them.
- **A replaced guard table covers only what it names.** The shipped table is the
  default, so nothing merges in: a `pathArguments` that omits `grep`, `glob`, or
  `lsp` stops fencing them, and this plugin is the only fence over those three.
  Copy the table from `--dump-config` or from this README rather than writing it
  from memory.
- **A tool the operator adds to the guard is fenced by path only.** The guard
  reads the argument the config names; it cannot know what the tool does with it.
  An entry that names the wrong argument carries nothing to inspect and therefore
  fences nothing, which is why new entries are worth testing against a real call.
- **The mounts on the five rows must be configured identically.** `sessionsRoot`,
  `attachmentsRoot`, `spillRoot`, `agentsHome`, `skillsRoot`, and
  `userInstructionsFile` appear on more than one row, and nothing checks the
  agreement: the rows are separate plugins. A mismatch makes one plugin write or
  address a directory the others resolve elsewhere, which fails as a missing file
  rather than as a denial. The loaders that read through these mounts
  (`skill-filesystem.dshHome`/`agentsHome`, `agent-instructions.dshHome`) must
  name the same tree — the loader rows in namespace spellings (`/`, `/agents`),
  the mount rows in host directories — and their failure is silent: an
  unresolvable path reads as an empty skills catalog or an absent user-global
  instruction file.
- **A directory listing omits children the fence cannot name.** A link pointing
  out of the workspace, and a target that vanished between the listing and its
  resolution, appear in `bash` (`ls` shows the entry) but not in a tool listing.
  The alternative — listing the entry with the host target it resolved to —
  would let a follow-up operation on that target leave the fence. A link whose
  target stays inside the namespace is listed under its own name and reads
  normally.
- **The guard fences calls that carry no agent session.** Its mount table is
  anchored at the deployment's configured workspace rather than at a session, so
  an agentless call is checked the same way. Those calls used to be deferred to
  the filesystem backend, which cannot see `grep`, `glob`, `lsp`, `bash`,
  `pwsh`, or `terminal` — the tools only this guard covers — and a host path must
  not be nameable there either.
- **A skill created during a session is announced only when the `write` or `edit`
  tool creates it.** `skill-filesystem` rebuilds its catalog on two signals: a
  host chokidar watcher rooted at each skill root, and a first-party mutation
  hook that fires for `write`/`edit` through `ctx.fs`. The watcher cannot work
  here — the roots are virtual paths that exist only inside the sandbox, so it
  walks up to the host's `/` and waits for a first segment that never appears
  (`node scripts/inspect-session-skills.mjs --watch-anchor /workspace/.agents/skills`
  prints that walk). A skill authored with `bash` therefore stays invisible to
  the `skill` tool until the session restarts, while one written with the `write`
  tool appears on the next request.
- **A consumer that treats the policy's workspace root as a host path sees
  `/workspace`.** The field's contract says the root is spelled the way the
  execution world spells it, and the sandboxed consumers want that: the PTY
  shell, the shell tool's default workdir, and the BFF's workspace scope are all
  correct with it. The stock filesystem fence is not — which is why
  `fs-bwrap` owns its own writable set — and the PTC runtime spawns its child
  with `cwd = policy.workspaceRoot`, a directory that does not exist on the host.
  `run_code` is not part of this bundle's profile, so that one is untested here.
- **`writableRoots` must list the same mounts on `bwrap-sandbox` and
  `fs-bwrap`.** They are separate plugins and nothing checks the agreement. A
  mount writable only in the profile fails at the tool fence, one writable only
  in the tools fails with `read-only file system` inside the sandbox, and listing
  `/AGENTS.md` makes the user-global instructions writable by the session that
  reads them.
- **The guard cannot inspect a path it cannot map.** It answers `not found` for a
  name outside the mounts, but an unexpected failure while mapping — an
  unreadable directory on the way, say — still surfaces as
  `path boundary: ... cannot inspect it (...)`. That is deliberate: the first is a
  namespace answer, the second is a real error worth reporting.
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
- **An extra mount root is one name, and the host directory behind it is free.**
  `additionalReadOnlyRoots` is read by all four rows, so a directory the operator
  adds is visible to the file tools and to a confined process at the same name.
  The name has to be a single top-level segment because a mount point is created
  on the namespace root, and a read-only bind cannot host a mount point inside
  it — which is also why the host directory may be nested while its name cannot:
  `my_files: /home/deepseek/my_files` binds under `/my_files` and leaves
  `/home/deepseek` unnameable. `/tmp` is reserved while `privateTmp` is on, since
  the private tmpfs would otherwise hide the mount.
- **The session cwd is `/workspace`, which moves the session log and breaks
  resume of sessions recorded before it.** The headless runner takes the session
  cwd from `fs.processPath`, so sessions are keyed under
  `$DSH_HOME/sessions/--workspace--/` instead of a directory named after the host
  project, and a session recorded earlier carries the host path in its header.
  Resuming one of those fails loudly in two independent places: the runner
  compares the recorded cwd with the one it computed (`was recorded in
  "<host>", not "/workspace"`), and the store requires the log to sit at the path
  its header names (`header id "…" and cwd identify "…"`). The fences do accept a
  session whose root is the configured workspace, so such a session runs as far
  as the tools are concerned; only adoption fails.

  Rewriting the header repairs it. The log is a sequence of zstd frames with the
  header alone in the first, which is why recompressing the whole file as one
  frame reads as `corrupt Zstandard session log: first frame is not exactly one
  header line`:

  ```sh
  zstd -dc "$LOG" > /tmp/all.jsonl
  head -1 /tmp/all.jsonl | sed 's#"cwd":"[^"]*"#"cwd":"/workspace"#' > /tmp/h.jsonl
  tail -n +2 /tmp/all.jsonl > /tmp/rest.jsonl
  mkdir -p "$DSH_HOME/sessions/--workspace--/$ID"   # the path the store names in its error
  { zstd -q -c /tmp/h.jsonl; zstd -q -c /tmp/rest.jsonl; } \
    > "$DSH_HOME/sessions/--workspace--/$ID/session.v4.jsonl.zstd"
  rm -rf "$DSH_HOME/sessions/<old project key>/$ID"
  ```

  Measured on a repaired session: `--session-id` adopts it, a relative `write`
  resolves under the mounts, and the tool reports `<path>/workspace/...` with the
  file landing in the host workspace. Past events keep the host spellings they
  recorded (`bash` workdirs, tool-result paths); those are transcript content, and
  only the turns that follow are spelled in the namespace.
- **Harness components that treat the session cwd as a host path see
  `/workspace`.** The contract says the cwd is an execution-world path, and the
  sandboxed consumers want it that way: a PTY's start directory, a PTC child's
  cwd, and `sandbox-policy`'s policy line all become `/workspace`, which is what
  exists inside. A consumer that reaches the host instead — revealing a
  deliverable in the desktop's file manager, a Windows-ACL sandbox that resolves
  identity on its host — will not find that directory. Those are outside this
  bundle's rows.
- **`grep` and `glob` are disabled.** They spawn the packaged ripgrep on the
  harness host and hand it the model's path, so the two worlds cannot agree: the
  model knows only `/workspace/...`, which the host does not have, and the tool's
  default workdir is the session cwd, which is `/workspace` too. The guard still
  fences their argument, so nothing leaks, but a search cannot run — and no
  bundle row can rewrite an argument a tool passes to its own subprocess. The
  patch disables the row rather than leaving two tools that always fail. Search
  inside the sandbox instead (`bash` with `rg`/`grep`), or restore the tools by
  making them run ripgrep through the sandbox: spawn it under `ctx.shell` (or
  confine `ctx.subprocess`) and resolve the path with `ctx.fs.processPath`, which
  is the seam's answer for "a path a subprocess in this execution world can
  open". That is a change in the harness packages, not here.
- **A user interface that opens files must translate `/workspace/...` back.**
  The client knows the session's real cwd from its own launcher, so the mapping
  is mechanical, but a card that feeds the displayed path straight to a file
  opener will not find it.

# Plan: source control (commit per thread)

Threads, the central conversation and background jobs all edit one project folder at the same time: the folder the
page on the left is served from. Vizzo keeps a **change ledger** of which writer made which lines of the uncommitted
changes. That lets the user commit one thread's work without the others', from a **Changes window**. Deleting a
thread whose work finished commits that work by default.

Status: agreed with the reviewer after nine rounds of adversarial review (GPT-6-Astra, high), waiting for the product
owner's review. Undo / revert, push, branches and worktrees are out of scope (see the end).

## Principles

1. **Ownership needs evidence: a chain of custody.** Each edit tool reports the file's exact content before and
   after its edit. A line belongs to a writer only when those reported versions link up, byte for byte, from the
   base to what's on disk, and that writer's edit is the link that wrote the line. Timing never decides ownership,
   and nothing is reconstructed by reversing a payload. Every gap in the chain (the user's editor, a shell command,
   codegen, a formatter, Grok, a checkout) is **Other**.
2. **Ownership means identical content.** A line is a writer's if the bytes on disk are the bytes that writer's
   tool wrote, by the chain. (If the user deletes a line and retypes it identically, it still counts as the
   writer's: committing it commits exactly what the writer wrote.)
3. **Other is never committed implicitly.** No thread-scoped selection, and no automatic commit on delete, includes
   an Other change, or a component that mixes Other with a writer's change. Only an explicit tick in the Changes
   window does.
4. **A commit never touches the working folder.** It's built from frozen content in a temporary index. Running
   writers keep writing.
5. **When in doubt, refuse or fall back to Other**, with a reason the user can read. Never guess.

## Decisions

| Topic | Decision |
|---|---|
| One working folder | Every writer edits the project folder itself. No worktree per thread: the page is served from this folder and the user must see every change live. |
| Writers | Every Vizzo solver execution gets an immutable **execution id** at dispatch, registered in one writer registry (`server/changes/writers.ts`). The id belongs to a writer: a thread (its runs, follow-ups and reconcile runs), the central conversation (`pipeline.ts`), or a background job (`jobs.ts`). When a foreground request is handed off to a job (`pipeline.ts` gives `jobs.ts` the same running promise and session), the execution id and its pending events move to the job's writer in one step. Only the label changes. Each writer with changes gets a group in the Changes window. A job or central request is titled by its request. |
| Who owns commits | Vizzo. The solver prompt (`projectNote` in `server/adapters/claude.ts`, both the shell and no-shell variants; today it allows commits "unless the user asks") changes to: never stage, commit, stash, reset, check out, switch branches or push, even when asked; commits are made from Vizzo's Commit button. Where a harness can deny shell commands by pattern (Claude Code `--disallowedTools Bash(git commit:*)` etc.), those are denied. Elsewhere the prompt is best effort: existing sessions keep their old prompt until reopened, and aliases or scripts can get around it. That's acceptable because external commits are handled (see "HEAD moves"). |
| Selection unit | A **component**: a connected set of hunks, joined by ties (below). Every commit, interactive or from a delete, selects a set of components from one scan generation. A writer's **own** components contain only its hunks; its **tied** components also contain another writer's hunks or Other. |
| Ties | Two changes are tied when they're in one hunk, or when one writer's change rewrites or removes lines another writer added that are still uncommitted. Ties are per component, not per writer: A can have own components that commit alone and a tied one that waits. |
| A writer still working | Its components aren't selectable ("still working…"). "Working" is the registry's real state, not the thread's display state: an execution running, queued follow-ups, a reconcile run, a stop that hasn't settled, or edit events not yet processed. |
| Commit message | Prefilled by the fast tier from the writers' titles, the user's requests and the diff (stat + capped hunks); editable. Fallback if the model fails: the title and first request. |
| Hooks and signing | v1 builds commits with plumbing (`commit-tree`), so **pre-commit / commit-msg hooks don't run** (lint-staged and similar stash the working folder, which would race running writers). The window says so. Signing follows `commit.gpgSign` (`commit-tree -S`). Author and committer come from the user's git config. |
| The user's own staging | If the user has staged anything for a path in the commit (its real-index entry ≠ the base), that path is refused with a reason. Otherwise those entries are set to the new commit's blobs under Vizzo's locks (see "Committing"). |
| Not a git repo, submodules | Not a repo: the feature is hidden; delete works as today. Submodule paths (gitlinks) are Other and never committed by Vizzo. |
| No commit yet (unborn branch) | Supported: the base is the empty tree, the commit has no parent, and the branch ref is created only if it still doesn't exist. |
| Project scope | Discovered with `git rev-parse --show-toplevel --git-dir --git-common-dir` (handles a project in a subfolder, and `.git` as a file for worktrees). Only paths inside the project folder are tracked and shown. |
| Grok | Its stream reports no edits, so its changes are Other. A Grok thread can't commit by thread in v1; the window says why. |

## The ledger

### Edit events

Each harness adapter turns its stream into **edit events**: `(executionId, harness session id, tool call id, path,
from, to, outcome)`. `from` and `to` describe the file before and after the edit, as the tool reports them: full
content, or an exact diff with context and line numbers. Each event is processed exactly once, keyed by the
namespaced ids `(executionId, session id, tool call id)`. The processed keys are saved with the ledger, so a replay
after a reconnect or restart is ignored. Only successful outcomes count; a failed, cancelled or partial edit
produces no event, and its effect on the file, if any, is Other.

| harness | where | from → to |
|---|---|---|
| Claude Code | the `user` event's tool result for an Edit / MultiEdit / Write `tool_use`, not an error | `originalFile` (null = new file) → `originalFile` with `structuredPatch` applied; Write: → `content` |
| Codex | `item/completed` of a `fileChange` item, status completed | per change: add → `content`; delete → absent; update → the change's unified diff (and `move_path` for a move) |
| opencode | a completed edit/write/patch tool part, deduped by part id | the part's reported before/after file content, where the version exposes it |
| Pi / OhMyPi | `tool_execution_end` for a `tool_execution_start` id, not an error | the result's reported diff, where the version exposes it |
| Grok | – | none |

In milestone 1, these shapes are confirmed against recorded streams from the supported harness versions (fixtures
under `server/adapters/__fixtures__/`, with a missing start, a repeated completion, a reconnect and malformed
payloads). The Claude Code transcript fields `originalFile`, `structuredPatch` and `content` are already confirmed
in local sessions, as are Codex's `add` content and `update` unified diff. Where a harness doesn't report a usable
`from → to`, its adapter emits nothing, its changes are Other, and that harness's threads can't commit by thread.
NotebookEdit and anything else without an exact before/after emit nothing.

### Chain of custody

The ledger keeps, per tracked file, a short chain of **versions** (content hash; content kept in Vizzo's own
folder). It starts at the base content in working-tree form (`git cat-file --filters <base>:<path>`, or *absent*).
Each link between two versions is either an **edit link** (one edit event, owned by its writer) or a **gap** (Other).

When an edit event for F arrives (processing is serialized per file):

1. Find the version its `from` matches: full content by hash; a diff by applying it **exactly** (stated line
   numbers, every context and removed line identical; no fuzz, no offset) to a version, newest first.
2. **Match found** at version V. If V is the chain's newest version, the edit link V → `to` is appended. If later
   versions exist after V, a gap ended there: the chain splits at V, and the newer versions stay pending until links
   explain them.
3. **No match.** The event is kept **pending** for up to 2 minutes. A later version may be the one it starts from,
   for example when B wrote between A's write and A's event arriving. After that it's dropped, and its lines stay
   Other.
4. At a **scan** (below), the file on disk is read. If it equals the newest version, nothing changes. Otherwise a gap
   newest → disk is appended (Other), and pending events are tried against it.

Since every link is between exact versions, the line owners of any version on a chain fully linked from the base are
exact: blame along the chain (diff each link, its added lines get that link's owner, the base lines it removes get
that owner's tombstone). A gap's lines and removals are Other. An edit link that rewrites or removes lines added by
another link ties the two. With a diff-type `to` (Codex updates), the version after the link is the diff applied to
V, so its content is known exactly.

**Compaction**: once a prefix of a chain is fully linked and no pending event could attach to it, it's collapsed
into one annotated version (line owners + tombstones), so a chain stays short. A file with more than 20 versions
pending is collapsed with its unresolved part as Other.

**Entries, not just lines.** Each version also records the entry's **presence, type and mode** (regular file,
symlink with its link text read with `readlink`, executable bit). A change in presence (a file added or deleted,
including an empty file) is owned by the link that made it: a Write of a new file, a Codex add or delete. A type or
mode change is always Other, since no harness reports one. When an entry is built for a commit, every property not
selected keeps its base value, so a user's chmod never rides along with a writer's text edit. Content depends on its
entry existing: a content change to an entry whose addition or type change belongs to someone else is **tied** to it
(the user creates an empty file and A writes its first line: one component, with Other in it). A new entry made by a
writer gets mode `100644` (`120000` for a symlink), and an executable bit nobody reported is a separate Other hunk.
So no selection can produce content without its entry. A move (Codex `move_path`, `apply_patch` `Move to`) is one
**move entry** spanning both paths, committed whole or not at all.

**Budgets**: a file over 5 MB is never read or stored. It's Other, listed as "too large for Vizzo to track", and an
edit event whose content is over 5 MB is dropped the same way. Diffing and blame run in a worker thread, never on
the voice server's event loop.

### Scans

A **scan** builds the components. It runs when the window opens or is focused, every 2 s while the window is
visible, after ledger events (coalesced), and at the start of a commit. Each scan has a **generation** number.

1. `git status --porcelain=v2 -z --untracked-files=all -- <project>` lists the changed entries.
2. Each entry is read (within the budget) and checked against its chain (step 4 above). An untracked entry with no
   chain is a chain base = *absent* → gap = Other, unless an edit event's `from` = absent claims it (a new file).
3. Each file: diff the base → the current content, zero context. Each hunk's owners are the owners of its added
   lines and the tombstones of its removed lines. Removed base lines with no tombstone are Other. Structural changes
   (presence, type, mode) are their own hunks.
4. Hunks are joined into components by ties. A writer's group lists its own components and its tied ones.
5. **Whole entries are one component.** A file that can only be committed whole has all of its hunks joined into
   one component, with every owner and any Other in it. That's a file without identity conversion (below), a
   binary, LFS file or symlink, a move, or a `.gitattributes` file. **Identity conversion** means: no `filter`,
   `ident` or `working-tree-encoding` attribute **both** under the base tree's attributes
   (`git check-attr --source=<base>`) **and** under the folder's current ones, no CR byte in the base or the
   content, and the base blob's raw bytes equal its working form. Another writer's uncommitted `.gitattributes`
   edit therefore can't make a filtered file look raw. So a CRLF file that A and a still-running B both changed
   can't be committed as A's alone. The commit's step 4 recomputes this from the frozen content, so a selection made
   before the file gained a CR byte is refused as changed.

### HEAD moves

- **Vizzo's own commits**: the committed components' lines and tombstones are dropped from the annotations exactly.
  The chain's base becomes the committed content.
- **External moves** (a terminal commit, a branch switch, an agent committing anyway), detected at each event and
  scan by comparing the branch and its OID: every file whose base content changed gets a new base. Its current
  annotated content is re-blamed against the new base: owned lines the new base contains are simply not in a hunk any
  more. Tombstones are dropped, so base lines missing from the content are Other. Pending events for those files are
  dropped. A checkout's file writes have no edit events, so they become gaps (Other). Any open selection is stale
  (its generation is old). The window shows a notice ("HEAD moved: some changes are now marked Other").
- A file stops being tracked when its content equals its base. If HEAD later moves back, those changes show as
  Other.

### Storage

- Versions: plain bytes in Vizzo's own folder (`<config>/vizzo/ledger/<project id>/content/<sha>`). Nothing is
  written into the user's repository until a commit. (A commit's `hash-object -w` runs the repo's clean filters,
  which for LFS store the payload under `.git/lfs`. That's expected.)
- Chains, annotations, ties, processed event keys, writer records, closed groups and commit jobs: `ledger.json`
  next to `threads.json`, versioned, keyed by project id. Written durably: temp file, fsync, rename, fsync the
  folder. Content files are fsynced before the record that refers to them.
- Costs (measured on this repo, 353 files): one file read + hash ~15 ms, one diff ~20 ms, a status scan ~35 ms.
  Memory: the annotations, kilobytes. Disk: a few versions of each changed file, under 5 MB each.

## Committing

Commits are serialized per repository. Each step is journaled in `ledger.json` (durably) **before** it's taken, so
recovery always knows how far a job got. Two locks protect a commit, both taken through git's own lock files:

- **The index lock**: Vizzo creates `<git-dir>/index.lock` exclusively and holds it for the whole job. While it
  exists, `git add`, `commit`, `reset`, `checkout` and `switch` in a terminal fail cleanly instead of racing.
- **The ref lock**: a `git update-ref --stdin` transaction with `start`, `update HEAD <commit> <base OID>` (through
  HEAD, not `--no-deref`) and `prepare`. While it's prepared, git itself holds HEAD and the branch: `HEAD.lock` +
  `refs/heads/<branch>.lock` in the files format, `tables.list.lock` in reftable. Branch switches, including plain
  `git symbolic-ref`, are refused, and Vizzo can still read HEAD's target. Checked on git 2.54 in both formats.
  (Holding `HEAD.lock` by hand doesn't work: git's own branch update then fails on it. And `symref-verify HEAD` plus
  an update of its branch in one transaction is rejected as "multiple updates for 'HEAD'".)

The feature needs git ≥ 2.41 (`--attr-source`, below; the transaction verbs need 2.27). When a project opens,
Vizzo checks the version and probes `git --attr-source=<empty tree> hash-object --stdin`. If either fails, the
feature is shown as unavailable, with the reason.

Steps:

1. **Index lock.** Journal `locking` (job id, pid). Create `index.lock` exclusively; record its device and inode. If
   git holds it, retry for up to 2 s, then refuse ("git is busy").
2. **Base.** Read HEAD (a symbolic ref; detached → refuse) and the branch's OID (none → unborn). That OID and branch
   are used for every later step.
3. **Reserve.** The selected writers' next executions wait to start until the job ends.
4. **Scan and freeze.** A scan at this moment; then re-resolve the request: the components the user selected, by id
   and generation. If any of them changed (other members, different content, now tied to a running writer or to
   Other the user didn't tick), refuse with "changed meanwhile: review again". The exact bytes and entry properties
   to commit are frozen. Nothing below reads the working folder again.
5. **Validate**: no working writer in any selected component; no Other unless ticked explicitly; no path the user has
   staged (the real index, stable because Vizzo holds its lock); no merge, rebase, cherry-pick or revert in progress;
   no submodule path.
6. **Tree.** `GIT_INDEX_FILE=<tmp> git read-tree <base OID>` (or empty). Entries are written with
   `update-index --index-info` (explicit mode + OID; deletions as mode 0, never `--remove`, which checks the live
   folder). Then `write-tree`. How each entry's content is made depends on **conversion**:
   - First, the **attributes tree** *A*: every `.gitattributes` entry of the new tree (the base's, plus the selected
     ones, which are whole entries) is written to the temp index, and `write-tree` gives *A*. Every committed path is
     classified again under *A* (`git check-attr --source=<A>`). If a path the scan treated as identity-converted
     isn't identity under *A* (possible only when several nested `.gitattributes` files are dirty), the commit is
     refused as "changed meanwhile: review again".
   - **Line-level (partial) content** is allowed only where conversion is the identity (scan step 5, and under *A*).
     Then the base blob *is* the working form. The committed content = the base with the
     selected hunks substituted (no `git apply`, no context matching), hashed with `hash-object -w --no-filters`.
     Nothing about attributes or config can change those bytes.
   - **Everything else is a whole entry**, converted with **the attributes of the tree being committed**, never the
     live folder's: each whole entry's frozen content is hashed with
     `git --attr-source=<A> hash-object -w --path=<path> --stdin`. A writer editing `.gitattributes` meanwhile, even
     for a moment, changes nothing. (Checked on git 2.54: with the live `.gitattributes` set to `-text` and *A* to
     `text`, a CRLF file hashes to its LF-normalized blob.) The user's `info/attributes`, global/system attributes and
     git config (including filter commands) are their own environment and are used just as `git add` would use
     them.
   - Symlinks are hashed raw (`--no-filters`) from the link text.
7. **Commit object**: `commit-tree <tree> [-p <base OID>] [-S]` with the message. Journal `publishing` with
   `{branch, base OID, commit, paths, base entries}`.
8. **Prepare the ref transaction**: `start`, `update HEAD <commit> <base OID>` (unborn: the zero OID as the old value,
   so it only creates), `prepare`. If prepare fails, nothing was published: journal `refused`, abort, release the
   index lock, and say "HEAD moved: review again". Under the prepared lock, read `git symbolic-ref HEAD`. If it isn't
   the captured branch, `abort` and refuse the same way. There's no retry onto a moved branch.
9. **Stage the new index without installing it.** Copy the real index to a temp file and apply
   `update-index --index-info` to it (the new commit's entries for the committed paths; every other entry and flag
   left as is). Write the result into the held `index.lock`, but **don't rename it yet**: the real index is untouched,
   and the lock stays held. Journal `index-ready`.
10. **Publish**: send `commit` to the transaction. Whether it was published is decided from **evidence of
    publication**, never from the branch tip alone. Commands that don't take the index lock (`git reset --soft`,
    plumbing `update-ref` and `symbolic-ref`) can move the branch or HEAD the moment git releases the ref locks.
    - **Published** if the transaction answered `commit: ok`. If it reported an error instead (git can install the
      branch and then fail writing a reflog), published only if the commit is **reachable from the branch**: the tip
      is the commit or descends from it.
    - **Not published** only if the transaction reported an error, the reflog has no entry for the commit, and the tip
      is still the base OID.
    - Otherwise **indeterminate**. That includes a reflog entry for the commit with the commit unreachable: git writes
      the reflog entry before it moves the branch, so the entry alone proves nothing.

    Then:
    - Published: rename `index.lock` over `index` (that installs the index and releases the lock). Journal `done`.
      This is right even if something moved the branch or HEAD in that moment. None of those commands touch the
      index, so the index keeps describing the commit that was checked out, which is C. After a `reset --soft` back to
      the base, for example, C's changes then show as staged, exactly as a soft reset leaves them.
    - Not published: delete `index.lock`. The real index was never changed, so there's nothing to roll back. Journal
      `not-published` and refuse.
    - Indeterminate: delete `index.lock` (index unchanged). Journal `indeterminate` (recovery, below).
11. The ledger drops the committed lines; components with nothing left disappear.

**Recovery** runs at start, before any commit or writer is allowed, for each job not `done`, `refused` or
`not-published`:

- **Locks**: a lock file is removed only if its device and inode match the journal and the journaled pid isn't
  running. Otherwise it's left alone, and the window says git is locked and by what. A prepared ref transaction dies
  with its `update-ref` process, and git removes its own locks.
- **`locking`** (nothing built): the job is refused, and its closed group stays.
- **`publishing`, `index-ready` or `indeterminate`**: is the commit on the branch? It is only if it's reachable from
  the branch: the tip is the commit or descends from it (`merge-base --is-ancestor`). A reflog entry alone (for
  example, after a crash, or after the user reset the branch away from the commit) is indeterminate, never
  published.
  - **Published, index not installed**: the index needs repair. (After `index-ready`, Vizzo's own `index.lock`, if
    it's still there and matches the journaled inode, already holds the right content. Repair then uses it as is,
    under the checks below.) Repair takes both locks the same way
    (index lock, then a transaction with `verify HEAD <commit>` and `prepare`). Under them it checks: HEAD still
    points to the branch, the tip is exactly the commit, and every committed path's index entry still equals the
    journaled base entry. Only then does it install the entries, exactly as in step 9. If anything differs, the index
    isn't touched. If the index still holds the old base for those paths while HEAD is the commit, the window shows
    "Vizzo committed X, but git's staging area wasn't updated: committing now would undo it", with a **Fix** button.
    Fix runs this same locked repair, never `git reset`.
  - **Not on the branch, no reflog entry, tip still the base OID**: not published. Vizzo's own leftover
    `index.lock` is deleted (by the lock rule above). The real index was never changed.
  - **Anything else is indeterminate**: no repair, and the job and its closed group are shown with "Vizzo can't tell
    whether this commit was made: check `git log`".
- **Deletes interrupted midway**: a closed group whose thread still exists in `threads.json` (a crash between writing
  the group and removing the thread) finishes the delete before that thread's session is reopened.

"Commit separately" runs one job per writer in window order. Its tied components go with the first writer selected
that's in them.

## Deleting a thread

What happens depends on the thread's real execution state and on whether its uncommitted work is **complete**.
Each execution's outcome is recorded (completed, stopped, failed, timed out, interrupted). A thread's work is
*incomplete* while any surviving owned change (lines, tombstones, or a presence change) comes from an execution that
didn't complete. It becomes complete again only when that execution is explicitly **continued** and the
continuation completes: **Resume** (today, for a thread interrupted by quitting) or **Continue** (new, in the panel
of a thread whose last task was stopped or failed; the same mechanism, a follow-up that continues the session and
names the unfinished request). Any other later execution, a new task, a question or a reconcile run, leaves it
incomplete. The user can still commit incomplete work explicitly from the window, where it's labelled. Saved with
the thread (`ThreadInfo.incomplete`).

| Thread when deleted | Dialog (panel) | Default | Without a dialog (sidebar ×, Clear, New conversation) |
|---|---|---|---|
| No uncommitted owned changes | Delete / Cancel | Delete | delete |
| Not working, work complete | **Commit and delete** / Delete, keep uncommitted / Cancel | Commit and delete | commit and delete |
| Not working, work incomplete | Delete, keep uncommitted / Cancel; says why ("the last task was stopped") | Keep | keep |
| Working (execution, queued follow-ups, reconcile, stopping) | **Stop and delete** (kept, "stopped part-way") / Cancel | Stop and delete | stop and keep |
| Queued feedback only (client-only, nothing sent) | today's local delete (`web/chat/main.ts`) | – | today's local delete |

**What "commit" commits on delete**: the thread's **own** components only. Tied components stay as a **closed group**
with the reason ("will be committed with 'the footer links'", "also has other changes"). If the thread has no own
components, nothing is committed and the notice says so. This is the same component rule an interactive commit uses.

**Batches** (Clear, New conversation): eligibility is decided for every thread **before** anything is stopped. A
thread that was working is stopped and kept. It never becomes eligible just because its thread was removed. Each
eligible thread is its own commit job, in order, own components only. The bulk confirmation says what will happen
("2 threads will be committed, 1 kept").

**Durable handoff**: on delete, the ledger first writes the closed group (title, requests, summary, its chains and
annotations) and, if committing, the commit job, durably. Only then is the thread removed from the store. The marker
and panel disappear at once, and the harness session is closed, freeing the RAM. The commit job runs in the
background. It's registered in `server/activity.ts` (so quitting asks, as for runs), and the `flush` handshake in
`electron/server-entry.ts` flushes the ledger too. Unfinished jobs go through recovery at start.

A failed or refused background commit leaves the closed group and shows a notice with the reason ("Couldn't commit
'the red button': you have staged changes in hero.css").

### Stop is a barrier

A stopped writer stays *working* until its harness has **settled**, that is, it can't write any more. Then the edit
events still in flight are processed. Only then is it "stopped part-way" and no longer working.

| harness | settled when |
|---|---|
| Claude Code, Pi / OhMyPi, Grok (a process per agent) | its turn's final result event arrives after the interrupt, or the process exits. After 30 s, the process is killed and settled on exit. |
| Codex (one shared `app-server`) | `turn/completed` for that thread's turn, with the listener kept until then (today a timeout removes the listener first, `harnesses.ts` ~978; that changes). |
| opencode (one shared `serve`) | the session reports idle after `abort`, with the subscription kept until then. |

For a shared server that doesn't confirm within 30 s, the writer is shown as "couldn't confirm it stopped". It stays
non-selectable, and the window offers **Restart Codex** (or opencode). That kills the shared server, after which every
writer on it is settled and interrupted. `harnessThread.ts` today rejects the caller as soon as stop wins the race. It
gets an awaitable `settled` for this.

## Projects

Every writer, ledger entry, closed group and commit job carries the **project id** (git common dir + worktree root).
Paths are resolved against that project, never the current one. Today, switching projects (`useProject` in
`electron/server-entry.ts`) keeps every thread and its session pinned to its old folder. So a thread from project P,
deleted while Q is open, commits into P. The Changes window shows the current project only. Every API request carries
the project id and scan generation, and requests for another project or a stale generation get `409` and a refresh.

## The Changes window

A separate window like Settings (`openSettings` in `electron/main.ts`): one instance, its size and place remembered,
a Vite page `web/changes.html` added to `vite.config.ts`'s build inputs. It reads the server over HTTP and stays
current over the WebSocket:

- `GET /api/changes?project=` → `{ generation, branch, base, groups: [{ writer: { kind: thread | central | job, id },
  title, state: open | working | stopping | closed, incomplete?, own: componentId[], tied: componentId[] }],
  components: [{ id, writers, other: boolean, files: [{ path, entry: text | binary | symlink | move | presence |
  mode, added, removed }] }], notices }`
- `GET /api/changes/diff?project=&generation=&component=&path=` → that component's hunks for one file, with owners.
- `POST /api/changes/message` `{ project, generation, components }` → a prefilled message.
- `POST /api/changes/commit` `{ project, generation, components, message, separately }` → the commits made, or the
  refusal and its reason.
- A `changes.updated` broadcast (project id + generation) when the ledger changes, so the window and the top-bar
  count follow. External changes are picked up by the 2 s scan while the window is visible.

Layout: a group per writer (title, files with +/−, expandable diffs with owners), its tied components drawn under it
with the reason and their own checkbox, components with Other marked "needs your call", "Other changes" last, the
message box, **Commit** / **Commit separately**, and a line saying hooks don't run.

Opened from:

- **The top bar**: a button right after the lightning (`#instant`) in `electron/shell/index.html`, with the count of
  changed files, hidden when the project isn't a git repo. The send-queue button, shown only with Instant off, moves
  after it. A new preload/IPC call opens the window (unscoped).
- **Each thread's panel**: a **Commit** button, enabled when the thread has uncommitted owned changes. It opens or
  focuses the window **scoped to that thread**: its own components ticked; its tied components shown, unticked,
  with the reason; the other writers' groups collapsed under "Other threads (N)", unticked. Opening it scoped again
  resets the scope.

## Changes to existing code

- `server/adapters/harnesses.ts`: per-harness edit-event adapters (table above), with the execution id; the Codex
  listener kept until the turn completes; `FilesTouched` stays for reconcile and the thread's message.
- `server/adapters/harnessThread.ts`: an awaitable `settled` after stop.
- New `server/changes/writers.ts`: the writer registry (execution ids, state, outcome, settling, reservations,
  handoff to jobs). `server/threads/runner.ts`, `server/orchestrators/pipeline.ts` and `server/orchestrators/jobs.ts`
  register their executions there.
- `server/threads/store.ts`, `server/session.ts`, `shared/protocol.ts`, `web/cursor/pageBridge.ts`
  (`PageThreadAction`): `thread.delete` gets `mode: commit | keep`, validated. `conversation.reset` and bulk delete
  use the batch rules.
- `server/adapters/claude.ts` (`projectNote`): Vizzo owns commits; Claude Code deny patterns for git write commands.
- `server/activity.ts`, `electron/server-entry.ts`: commit jobs as tasks; the ledger in `flush`.
- New: `server/changes/` (ledger, chains, scans, commit transaction, recovery, HTTP routes), `shared/changes.ts`
  (the contract), `web/changes.html` + `web/changes/`, the window in `electron/main.ts`, the top-bar button.
- `web/cursor/threadOverlay.ts`: the Commit button, the new delete dialog, and **Continue** for a stopped or failed
  task. `web/chat/main.ts`: ×, Clear and New conversation.

## Tests

- **Chains**, as pure functions over versions and events: A and B interleaved in one file; B writing between A's
  write and A's event arriving (A pending, then attached); a user edit while A thinks (a gap, Other); a Write whose
  `to` differs from the disk (a gap after it); `replace_all` (the tool's own patch, no reversal); a repeated event
  (processed once); an event that never attaches (dropped, Other); a delete-and-retype of an owned line; a move
  with an edit; a case-only rename; an empty-file add; the user creating a file A then writes into (tied to Other);
  a symlink; a chmod alongside a text edit; compaction.
- **Scans**: HEAD moving forward, back, and to another branch; a coincidental identical line in the new base; a
  component mixing a writer and Other; a file over 5 MB.
- **Commit transaction** against temporary repos: other writers' changes and the working folder untouched; the user's
  staging refused, other index entries and flags preserved; `git symbolic-ref` and `checkout` attempted while
  the transaction is prepared (refused, files and reftable formats); the old-value check failing; a branch at the
  same OID checked out between capture and prepare (aborted); an unborn branch (zero old value); the transaction's
  `commit` failing after the branch moved (a reflog write failure: published, by reachability); a failed publish
  (the real index byte-identical to before); `git reset --soft HEAD^` right after the transaction's `commit`
  (published, the index installed, C's changes staged); a failure injected between git's reflog write and the
  branch update (indeterminate: the index isn't installed, ownership isn't dropped, the closed group stays).
- **Conversion**: CRLF content (whole entry); a CRLF file changed by a finished A and a running B (one component: A
  can't commit it alone; delete keeps it as a closed group); a `filter` / `working-tree-encoding` file (whole
  entry); another writer changing `.gitattributes` (also in a parent folder of the project) during hashing and
  restoring it (no effect: `--attr-source`); an unselected `.gitattributes` edit that removes a filter **before**
  the freeze (the filtered file is still a whole entry, hashed through *A* with the base's filter); a selected
  `.gitattributes` change turning on `text` for a committed file; LFS; a deletion while the path was recreated on
  disk; a binary.
- **Recovery**: a crash at every journal phase; a published commit later advanced or reset; a branch switch after a
  crash (no index repair); the user staging a path while Fix is being prepared (Fix refuses under the locks);
  foreign locks left alone.
- **Writers**: the foreground-to-job handoff keeps one execution id; stop settlement per harness (fake servers that
  confirm late or never).
- **Delete matrix**: every row; a failed task followed by a question or an unrelated new task (still incomplete),
  then Continue (complete); Clear with a tied running pair; quit during a background commit.
- **Smoke**: two fake threads editing one file, commit one, check the commit, the index and the working folder.

## Milestones

1. **Ledger**: recorded harness fixtures, edit-event adapters, the writer registry (threads, central, jobs, handoff),
   stop settlement, chains, persistence, project ids, the agents' commit rule.
2. **Scans, the commit transaction and recovery** (pure + temp-repo tests).
3. **The Changes window**, the top-bar button, each thread's Commit button.
4. **Delete flows** (dialog, ×, Clear, New conversation), closed groups, background jobs, quit handling.

## Out of scope

Undo / revert of a writer, push and pull, creating or switching branches, running git hooks, picking single hunks
by hand (beyond ticking a tied or Other component), worktrees per thread, per-thread commits for Grok (and for any
harness without exact before/after reports), routing a spoken "commit this" to the window.

## Deviations

- Vizzo refuses commits when the real index is a symlink or an existing non-regular file. In a temporary repository,
  Git followed an index symlink and wrote to its target while the nominal `index.lock` was held. Installing the
  nominal lock would replace the symlink itself.
- Vizzo refuses commits when HEAD selects a branch that is itself a symbolic ref. This keeps the branch captured
  before the transaction, checked under the prepared lock, and used for publication evidence the same ref.
- Scans may run the repository's configured Git filters and allow their side effects before a commit. Both
  `git status` and `git cat-file --filters` ran filters that wrote files in temporary repositories, with both
  ref formats. The product owner approved this exception to preserve Git conversion and LFS support. Scans do
  not stage changes or update refs.
- Claude Code 2.1.327 attributes successful `Write` creates with explicit prior absence. Recorded tool results
  normalized CRLF and mixed line endings in `Edit` and in `Write` overwrite preimages without reporting the
  original line endings. Those edits remain Other under the exact-evidence rule. The installed CLI exposed no
  `MultiEdit` tool in the capture.
- Codex 0.170.0 attributes only completed batches of exact updates and deletions. Recorded `add` results were
  identical for create and overwrite, and move results omitted whether they overwrote a destination. A case-only
  move even reported success after removing the file on the case-insensitive test volume. Batches containing
  these ambiguous operations remain Other under the exact-evidence rule.
- A selected `.gitattributes` file whose own clean conversion changes its bytes gets one rebuilt attributes tree.
  Vizzo refuses the commit if converting the frozen attributes under that tree still produces different bytes.
  A clean filter can change which filter applies to `.gitattributes` itself, and a temporary-repo probe produced
  a cycle with no stable tree. The verification permits stable normalization such as CRLF to LF.
- Normal Git reads can refresh the modification time of a split index's shared cache even with optional locks
  disabled. Vizzo allows that Git housekeeping. For commits, the prepared replacement may use a self-contained
  index so recovery can validate and install it with the same entries and flags after a crash.
- Preparing the replacement index disables Git fsmonitor and resets its validity cache. Git otherwise invoked a
  configured fsmonitor hook while updating a copied index. User-facing index flags such as assume-unchanged and
  skip-worktree are preserved.
- The 5 MB budget and gitlink exclusion apply to Vizzo's content readers and ledger. Git's porcelain status
  may itself read a larger tracked file or inspect a submodule to determine whether the entry is dirty. Vizzo
  keeps no content from those reads and reports unsupported entries as Other.
- Identity checks use `git check-attr --all` and treat any reported `filter`, `ident`, or `working-tree-encoding`
  as whole-entry conversion, including an explicitly unset attribute. Named queries display `unspecified` for
  both absence and a literal value of that name. An explicit `unset` also collides with a literal driver name.
- A full before-and-after report can reconnect from a historical version past an explained edit only when an
  independent disk observation matches its after-version at an unresolved gap. The intervening rollback stays
  Other. A partial patch cannot establish that rollback, and a report cannot replace an explained endpoint.

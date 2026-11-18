export interface ChangeWriter {
  readonly kind: "thread" | "central" | "job";
  readonly id: string;
}

export interface ChangeGroup {
  readonly writer: ChangeWriter;
  readonly title: string;
  readonly state: "open" | "working" | "stopping" | "closed";
  readonly reason?: string;
  readonly incomplete?: boolean;
  readonly own: readonly string[];
  readonly tied: readonly string[];
}

export interface ChangeFile {
  /** Project-relative display path. */
  readonly path: string;
  readonly entry: "text" | "binary" | "symlink" | "move" | "presence" | "mode" | "unavailable";
  readonly added: number;
  readonly removed: number;
}

export interface ChangeComponent {
  readonly id: string;
  readonly writers: readonly ChangeWriter[];
  readonly other: boolean;
  readonly files: readonly ChangeFile[];
  readonly selectable: boolean;
  readonly reason?: string;
  readonly tieReason?: string;
  readonly incomplete?: boolean;
  /** Components that must also be selected, such as the creation of a newly executable file. */
  readonly requires?: readonly string[];
}

export interface ChangesView {
  readonly generation: number;
  readonly branch: string | null;
  readonly base: string | null;
  readonly groups: readonly ChangeGroup[];
  readonly components: readonly ChangeComponent[];
  readonly notices: readonly string[];
  readonly changedFiles: number;
}

/** Bootstrap the Changes window before it has a project and a scan generation. */
export type ChangesStatus =
  | { readonly kind: "none" | "loading" }
  | { readonly kind: "non-repository"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string; readonly project?: string }
  | {
    readonly kind: "ready";
    readonly project: string;
    readonly generation: number;
    readonly changedFiles: number;
    readonly ownedThreadIds: readonly string[];
  };

export interface ChangesSelectionRequest {
  readonly project: string;
  readonly generation: number;
  /** Exact checkboxes selected by the user, including explicit selections of Other. */
  readonly components: readonly string[];
}

export interface ChangesCommitRequest extends ChangesSelectionRequest {
  readonly message: string;
  readonly separately: boolean;
  /** The first displayed writer group, when the user opens the window from a thread. */
  readonly scopeThreadId?: string;
}

export type ChangesMessageResult = { readonly message: string };
export type ChangesCommitResult = { readonly commits: readonly string[] } | ChangesRefusal;
export type ChangesRefusal = { readonly reason: string; readonly commits?: readonly string[] };
export type ChangesActionResult = { readonly ok: true } | ChangesRefusal;

export type ChangesRestartHarness = "codex" | "opencode";

export interface ChangesJobs {
  readonly jobs: readonly { readonly id: string; readonly commit?: string; readonly reason?: string; readonly canFix: boolean }[];
  readonly restart: readonly ChangesRestartHarness[];
}

export interface ChangesFixRequest {
  readonly project: string;
  readonly jobId: string;
}

export interface ChangesRestartRequest {
  readonly project: string;
  readonly generation?: number;
  readonly harness: ChangesRestartHarness;
}

/** Zero-based line offsets, including the insertion position when a count is zero. */
export interface ChangeRange {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

export interface ChangeHunk {
  readonly kind: "content" | "presence" | "type" | "mode" | "opaque";
  readonly range?: ChangeRange;
  readonly before?: string;
  readonly after?: string;
  readonly writers: readonly ChangeWriter[];
  readonly other: boolean;
  readonly reason?: string;
}

export interface ChangeDiff {
  readonly generation: number;
  readonly component: string;
  readonly path: string;
  readonly hunks: readonly ChangeHunk[];
}

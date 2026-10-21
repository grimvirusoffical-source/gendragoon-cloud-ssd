import type { LockAssessment } from "./policy.js";

export type NodeKind = "file" | "folder" | "app";
export type BrowserMode = "upload" | "backup";

export interface TreeNode {
  id: string;
  path: string;
  name: string;
  kind: NodeKind;
  hasChildren: boolean;
  selectable: boolean;
  symlink: boolean;
  sizeBytes?: number;
  mime?: string;
  children?: TreeNode[];
}

export interface BrowserActions {
  canUpload: boolean;
  canBackup: boolean;
  canDownload: boolean;
  canRefresh: boolean;
  primaryLabel: string | null;
}

export function kindFromName(name: string, directory: boolean): NodeKind {
  if (directory && name.toLowerCase().endsWith(".app")) return "app";
  return directory ? "folder" : "file";
}

/** Application bundles are selected whole. Ported from gendragoon_upload_workspace.py. */
export function assertNotInsideApp(path: string): void {
  const parts = path.split(/[/\\]/).filter((part) => part.length > 0);
  const parents = parts.slice(0, -1);
  if (parents.some((part) => part.toLowerCase().endsWith(".app"))) {
    throw new Error("Select the complete application bundle rather than its internal files");
  }
}

export function treeNode(input: {
  path: string;
  directory: boolean;
  symlink?: boolean;
  sizeBytes?: number;
  mime?: string;
  children?: TreeNode[];
}): TreeNode {
  const name = input.path.split(/[/\\]/).filter(Boolean).pop() ?? input.path;
  const kind = kindFromName(name, input.directory);
  return {
    id: input.path,
    path: input.path,
    name,
    kind,
    hasChildren: input.directory && kind !== "app",
    selectable: !input.symlink && (input.directory || kind === "file"),
    symlink: input.symlink === true,
    ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    ...(input.mime !== undefined ? { mime: input.mime } : {}),
    ...(input.children !== undefined ? { children: input.children } : {}),
  };
}

/**
 * Uploader and backup manager share one tree. Backup has no upload button:
 * refresh, select, then "Make secure backup". A login lock still allows
 * download and blocks both upload and new backups.
 */
export function actionsForMode(
  mode: BrowserMode,
  selection: TreeNode | null,
  lock?: Pick<LockAssessment, "uploadsBlocked">,
): BrowserActions {
  const selectable = Boolean(selection?.selectable);
  if (lock?.uploadsBlocked) {
    return {
      canUpload: false,
      canBackup: false,
      canDownload: true,
      canRefresh: true,
      primaryLabel: null,
    };
  }
  if (mode === "backup") {
    return {
      canUpload: false,
      canBackup: selectable,
      canDownload: true,
      canRefresh: true,
      primaryLabel: selectable ? "Make secure backup" : null,
    };
  }
  return {
    canUpload: selectable,
    canBackup: false,
    canDownload: true,
    canRefresh: true,
    primaryLabel: selectable ? "Upload" : null,
  };
}

export interface SourceRecord {
  id: string;
  path: string;
  name: string;
  kind: NodeKind;
}

export type JobState = "queued" | "running" | "succeeded" | "failed";

export interface UploadJob {
  id: string;
  state: JobState;
  workspaceId: string;
  mode: BrowserMode;
  sources: SourceRecord[];
}

export interface UploadWorkspaceState {
  schema: 1;
  revision: number;
  workspaceId: string | null;
  mode: BrowserMode;
  sources: SourceRecord[];
  jobs: UploadJob[];
  activeJobId: string | null;
}

export function freshUploadState(mode: BrowserMode = "upload"): UploadWorkspaceState {
  return { schema: 1, revision: 0, workspaceId: null, mode, sources: [], jobs: [], activeJobId: null };
}

export function requireRevision(state: UploadWorkspaceState, expected: number): void {
  if (!Number.isInteger(expected) || state.revision !== expected) {
    throw new Error("The upload workspace changed; refresh and try again");
  }
}

export function requireIdle(state: UploadWorkspaceState): void {
  if (state.activeJobId !== null) {
    throw new Error("Wait for the active transfer before changing the selection");
  }
}

function commit(state: UploadWorkspaceState, patch: Partial<UploadWorkspaceState>): UploadWorkspaceState {
  return { ...state, ...patch, revision: state.revision + 1 };
}

export function selectWorkspace(
  state: UploadWorkspaceState,
  expectedRevision: number,
  workspaceId: string,
): UploadWorkspaceState {
  requireRevision(state, expectedRevision);
  requireIdle(state);
  if (!workspaceId) throw new Error("Choose a workspace");
  return commit(state, { workspaceId });
}

export function enqueueSelection(
  state: UploadWorkspaceState,
  expectedRevision: number,
  jobId: string,
): UploadWorkspaceState {
  requireRevision(state, expectedRevision);
  requireIdle(state);
  if (!state.workspaceId) throw new Error("Choose a workspace");
  if (state.sources.length === 0) throw new Error("Select an item first");
  const job: UploadJob = {
    id: jobId,
    state: "queued",
    workspaceId: state.workspaceId,
    mode: state.mode,
    sources: state.sources.map((source) => ({ ...source })),
  };
  return commit(state, { jobs: [...state.jobs, job] });
}

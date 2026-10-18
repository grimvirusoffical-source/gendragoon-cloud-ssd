import { assertNoCredentialFields, BYO_PRESIGNED_URL_MESSAGE, BYO_UNSUPPORTED_MESSAGE, BYO_UNVERIFIABLE_MESSAGE } from "../byo.js";
import { assertKeyEnvelope } from "../envelope.js";
import { AccountDeletedError, ApiError, DeletionNotFoundError, InvalidTokenError, ReauthRequiredError, WorkspaceLockedError, deletionAuthFailure, isAccountDeleted, isInvalidToken, isReauthRequired } from "./errors.js";
import { assertStorageUrlResponse, reauthIsRecent, reauthenticatedAtForDelete } from "../storage.js";
import type {
  AccessResponse,
  BillingStatusResponse,
  ByoChallengeResponse,
  ByoProofRequest,
  ByoProofResponse,
  CapabilitiesResponse,
  CheckoutResponse,
  CloudFile,
  CreateUploadRequest,
  FileListResponse,
  HealthResponse,
  MergePreviewResponse,
  MergeRequest,
  MergeResponse,
  ByoRegisterRequest,
  PricingResponse,
  ProjectListResponse,
  UploadStatus,
  Workspace,
  WorkspaceFeeCheckout,
  WorkspaceListResponse,
  StorageUrlRequest,
  StorageUrlResponse,
  DeleteAccountRequest,
  DeleteAccountAccepted,
  AccountDeletionStatus,
  KeyEnvelope,
} from "./types.js";

export {
  AccountDeletedError,
  ApiError,
  DeletionNotFoundError,
  InvalidTokenError,
  ReauthRequiredError,
  WorkspaceLockedError,
  deletionAuthFailure,
  isAccountDeleted,
  isInvalidToken,
  isReauthRequired,
};

export interface ClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | undefined> | string | undefined;
  fetch?: typeof fetch;
}


/**
 * Typed caller for the deployed routes, plus the proposed Riley routes.
 * Authorization values are never copied into errors.
 */
export class GenDragoonClient {
  private readonly baseUrl: string;
  private readonly getToken: ClientOptions["getToken"];
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.getToken = options.getToken;
    this.fetchImpl = options.fetch ?? fetch;
  }

  health(): Promise<HealthResponse> {
    return this.request("GET", "/health");
  }

  capabilities(): Promise<CapabilitiesResponse> {
    return this.request("GET", "/v3/capabilities");
  }

  billingStatus(): Promise<BillingStatusResponse> {
    return this.request("GET", "/v2/billing/status");
  }

  pricing(): Promise<PricingResponse> {
    return this.request("GET", "/v2/pricing");
  }

  me(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/me");
  }

  listWorkspaces(): Promise<WorkspaceListResponse> {
    return this.request("GET", "/v2/workspaces");
  }

  listProjects(includeArchived = false): Promise<ProjectListResponse> {
    const query = includeArchived ? "?includeArchived=true" : "";
    return this.request("GET", `/v2/projects${query}`);
  }

  getProject(id: string): Promise<Workspace> {
    return this.request("GET", `/v2/projects/${encodeURIComponent(id)}`);
  }

  createProject(body: { name: string; intentId: string }): Promise<Record<string, unknown>> {
    return this.request("POST", "/v2/projects", body);
  }

  checkoutProject(id: string): Promise<CheckoutResponse> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(id)}/checkout`);
  }

  setSelection(id: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    return this.request("PUT", `/v2/projects/${encodeURIComponent(id)}/selection`, body);
  }

  archiveProject(id: string, body: { confirmName: string; acknowledgeBillingContinues?: boolean }): Promise<Record<string, unknown>> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(id)}/archive`, body);
  }

  restoreProject(id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(id)}/restore`);
  }

  checkoutStorage(id: string, body: { tier: string; interval: "month" | "year"; mode: "standard" | "bundle" }): Promise<CheckoutResponse> {
    return this.request("POST", `/v2/workspaces/${encodeURIComponent(id)}/checkout/storage`, body);
  }

  checkoutPerformance(id: string, body: { tier: string; interval: "month" | "year" }): Promise<CheckoutResponse> {
    return this.request("POST", `/v2/workspaces/${encodeURIComponent(id)}/checkout/performance`, body);
  }

  checkoutByoSubscription(id: string, body: { interval: "month" | "year" }): Promise<CheckoutResponse> {
    return this.request("POST", `/v2/workspaces/${encodeURIComponent(id)}/checkout/byo`, body);
  }

  /**
   * Existing route. Credential fields are rejected before the request.
   * Prefer the proposed challenge flow for activation.
   */
  async registerManualProvider(id: string, body: { provider: string; label: string; connectionTested: true }): Promise<Record<string, unknown>> {
    assertNoCredentialFields(body);
    return this.request("POST", `/v2/workspaces/${encodeURIComponent(id)}/manual-provider`, body);
  }

  entitlements(): Promise<{ adFree: boolean; ownerBenefits: boolean }> {
    return this.request("GET", "/v2/account/entitlements");
  }

  customerPortal(): Promise<{ url: string }> {
    return this.request("POST", "/billing/customer-portal");
  }

  listFiles(workspaceId: string, cursor?: string): Promise<FileListResponse> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.request("GET", `${this.cloud(workspaceId)}/files${query}`);
  }

  createUpload(workspaceId: string, body: CreateUploadRequest): Promise<UploadStatus> {
    return this.request("POST", `${this.cloud(workspaceId)}/uploads`, body);
  }

  uploadStatus(workspaceId: string, uploadId: string): Promise<UploadStatus> {
    return this.request("GET", `${this.cloud(workspaceId)}/uploads/${encodeURIComponent(uploadId)}`);
  }

  async uploadChunk(workspaceId: string, uploadId: string, index: number, bytes: Uint8Array, sha256: string): Promise<{ saved: boolean; index: number }> {
    return this.request(
      "PUT",
      `${this.cloud(workspaceId)}/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`,
      bytes,
      { "content-type": "application/octet-stream", "x-chunk-sha256": sha256 },
    );
  }

  finalizeUpload(workspaceId: string, uploadId: string): Promise<{ saved: boolean; fileId?: string }> {
    return this.request("POST", `${this.cloud(workspaceId)}/uploads/${encodeURIComponent(uploadId)}/finalize`);
  }

  cancelUpload(workspaceId: string, uploadId: string): Promise<{ cancelled: boolean }> {
    return this.request("DELETE", `${this.cloud(workspaceId)}/uploads/${encodeURIComponent(uploadId)}`);
  }

  deleteFile(workspaceId: string, fileId: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `${this.cloud(workspaceId)}/files/${encodeURIComponent(fileId)}`);
  }

  /**
   * Short-lived V4 or resumable URLs scoped to the workspace prefix.
   * A locked workspace is download-only. Writes from the server come back as HTTP 423.
   */
  async storageUrls(id: string, body: StorageUrlRequest): Promise<StorageUrlResponse> {
    assertNoCredentialFields(body);
    const response = await this.request<StorageUrlResponse>("POST", `/v2/workspaces/${encodeURIComponent(id)}/storage-urls`, body);
    assertStorageUrlResponse(response);
    return response;
  }

  /**
   * DELETE /v2/account. The body is only `{confirm:"DELETE"}`.
   * A recent sign-in is required first. An ID token is judged by `auth_time`, not by a refresh `iat`.
   */
  async deleteAccount(body: DeleteAccountRequest): Promise<DeleteAccountAccepted> {
    if (!reauthIsRecent(reauthenticatedAtForDelete(body))) throw new ReauthRequiredError();
    const accepted = await this.request<DeleteAccountAccepted>("DELETE", "/v2/account", { confirm: "DELETE" });
    if (!accepted?.jobId) throw new ApiError(502, "DELETION_UNCONFIRMED", "Account deletion was not accepted");
    return accepted;
  }

  /**
   * Plural path. Poll until `done` or `failed`.
   * A status token authenticates this GET. The Firebase ID token is not sent with it.
   */
  deletionStatus(jobId: string, statusToken?: string): Promise<AccountDeletionStatus> {
    const headers = statusToken ? { Authorization: `Bearer ${statusToken}` } : undefined;
    return this.request("GET", `/v2/account/deletions/${encodeURIComponent(jobId)}`, undefined, headers);
  }

  /** Server stores this envelope and nothing else about the workspace key. */
  async getKeyEnvelope(id: string): Promise<KeyEnvelope> {
    const envelope = await this.request<KeyEnvelope>("GET", `/v2/workspaces/${encodeURIComponent(id)}/key-envelope`);
    assertKeyEnvelope(envelope);
    return envelope;
  }

  async putKeyEnvelope(id: string, envelope: KeyEnvelope): Promise<KeyEnvelope> {
    assertKeyEnvelope(envelope);
    return this.request("PUT", `/v2/workspaces/${encodeURIComponent(id)}/key-envelope`, envelope);
  }

  /** Proposed. Recurring workspace fee, distinct from one-time project activation. */
  checkoutWorkspaceFee(id: string): Promise<WorkspaceFeeCheckout> {
    return this.request("POST", `/v2/workspaces/${encodeURIComponent(id)}/checkout/workspace-fee`);
  }

  /** POST /v2/workspaces/:sourceId/merge with `{ targetId, confirmName }`. */
  mergeWorkspaces(body: MergeRequest): Promise<MergeResponse> {
    const { sourceId, targetId, confirmName } = body;
    return this.request("POST", `/v2/workspaces/${encodeURIComponent(sourceId)}/merge`, { targetId, confirmName });
  }

  /** POST /v2/workspaces/:sourceId/merge/preview. Same body as merge. */
  previewMerge(body: MergeRequest): Promise<MergePreviewResponse> {
    const { sourceId, targetId, confirmName } = body;
    return this.request("POST", `/v2/workspaces/${encodeURIComponent(sourceId)}/merge/preview`, { targetId, confirmName });
  }

  /** Proposed lock-resolution delete. Archive remains the live non-destructive removal. */
  deleteWorkspace(id: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/v2/workspaces/${encodeURIComponent(id)}`);
  }

  /** POST /v2/workspaces/:id/byo/register. SFTP and the other coming-soon providers return 422. */
  async registerByo(id: string, body: ByoRegisterRequest): Promise<Record<string, unknown>> {
    assertNoCredentialFields(body);
    const bucketFingerprint = (body.bucketFingerprint || body.hostFingerprint || "").trim();
    const payload = {
      provider: body.provider,
      endpoint: body.endpoint,
      ...(bucketFingerprint ? { bucketFingerprint } : {}),
    };
    return this.request("POST", `/v2/workspaces/${encodeURIComponent(id)}/byo/register`, payload);
  }

  /** POST /v2/workspaces/:id/byo/challenge. No body. Response is `{ nonce, expiresAtMs, ttlMs }`. */
  createByoChallenge(id: string): Promise<ByoChallengeResponse> {
    return this.request("POST", `/v2/workspaces/${encodeURIComponent(id)}/byo/challenge`);
  }

  /**
   * POST /v2/workspaces/:id/byo/verify.
   * The body is `{ presignedUrl }` with a non-empty URL, otherwise `{}`.
   * A missing URL is 400 `presigned_url_required`.
   */
  async verifyByo(id: string, body: ByoProofRequest): Promise<ByoProofResponse> {
    const presignedUrl = typeof body?.presignedUrl === "string" ? body.presignedUrl.trim() : "";
    const payload = presignedUrl ? { presignedUrl } : {};
    assertNoCredentialFields(payload);
    return this.request("POST", `/v2/workspaces/${encodeURIComponent(id)}/byo/verify`, payload);
  }

  async submitByoProof(id: string, body: { presignedUrl?: string; presignedGetUrl?: string }): Promise<ByoProofResponse> {
    const presignedUrl = body?.presignedUrl ?? body?.presignedGetUrl ?? "";
    return this.verifyByo(id, { presignedUrl });
  }

  /** Proposed. Server-computed lock. Clients render this instead of deciding access. */
  access(): Promise<AccessResponse> {
    return this.request("GET", "/v2/access");
  }

  async download(workspaceId: string, file: Pick<CloudFile, "id">): Promise<Response> {
    return this.raw("GET", `${this.cloud(workspaceId)}/files/${encodeURIComponent(file.id)}/download`);
  }

  private cloud(workspaceId: string): string {
    return `/v2/workspaces/${encodeURIComponent(workspaceId)}/cloud`;
  }

  private async request<T>(method: string, path: string, body?: object | Uint8Array, extraHeaders?: Record<string, string>): Promise<T> {
    const response = await this.raw(method, path, body, extraHeaders);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const parsed = text ? safeJson(text) : null;
    if (!response.ok) throw toError(response.status, parsed);
    return parsed as T;
  }

  private async raw(method: string, path: string, body?: object | Uint8Array, extraHeaders?: Record<string, string>): Promise<Response> {
    const headers = new Headers();
    let authorization: string | undefined;
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        if (key.toLowerCase() === "authorization") authorization = value;
        else headers.set(key, value);
      }
    }
    // A deletion status token replaces the Firebase token. Do not call getToken:
    // after sign-out that hook throws, and resume must still be able to poll.
    if (authorization) {
      headers.set("Authorization", authorization);
    } else {
      const token = await this.getToken();
      if (token) headers.set("Authorization", `Bearer ${token}`);
    }
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) {
      payload = body;
      if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers.set("content-type", "application/json");
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: payload });
    } catch {
      throw new ApiError(0, "NETWORK", "Request failed");
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: "Unreadable response" };
  }
}

function toError(status: number, parsed: unknown): ApiError {
  const record = parsed && typeof parsed === "object"
    ? parsed as {
      error?: unknown;
      code?: unknown;
      message?: unknown;
      jobId?: unknown;
      statusToken?: unknown;
      reason?: unknown;
      overBy?: unknown;
      unpaidWorkspaceIds?: unknown;
    }
    : {};
  const code = typeof record.code === "string" ? record.code : "";
  const errorField = typeof record.error === "string" ? record.error : "";
  const machine = machineCode(errorField, code);
  const jobId = typeof record.jobId === "string" ? record.jobId : "";
  const statusToken = typeof record.statusToken === "string" && record.statusToken ? record.statusToken : undefined;
  const accountDeleted = machine === "account_deleted" || code === "account_deleted" || errorField === "account_deleted";
  if (status === 410 && accountDeleted && jobId) return new AccountDeletedError(jobId, statusToken);
  if (status === 423 || machine === "workspace_lock" || code === "workspace_lock") {
    const unpaid = Array.isArray(record.unpaidWorkspaceIds)
      ? record.unpaidWorkspaceIds.filter((id): id is string => typeof id === "string")
      : [];
    return new WorkspaceLockedError({
      reason: typeof record.reason === "string" ? record.reason : "",
      overBy: typeof record.overBy === "number" ? record.overBy : 0,
      unpaidWorkspaceIds: unpaid,
    });
  }
  if (status === 401 && machine === "reauth_required") return new ReauthRequiredError();
  if (status === 401 && machine === "invalid_token") return new InvalidTokenError();
  // A 401 with no machine code follows the same path as reauth_required.
  if (status === 401 && !machine) return new ReauthRequiredError();
  if (status === 422 && machine === "byo_provider_unsupported") {
    return new ApiError(422, "byo_provider_unsupported", BYO_UNSUPPORTED_MESSAGE);
  }
  if (machine === "presigned_url_required") {
    return new ApiError(status || 400, "presigned_url_required", BYO_PRESIGNED_URL_MESSAGE);
  }
  // Fallback only. Riley's BYO fixtures do not include 409 byo_unverifiable.
  if (status === 409 && machine === "byo_unverifiable") {
    return new ApiError(409, "byo_unverifiable", BYO_UNVERIFIABLE_MESSAGE);
  }
  if (status === 404 || machine === "PROJECT_FORBIDDEN" || code === "PROJECT_FORBIDDEN") {
    return new ApiError(404, "NOT_FOUND", "Not found");
  }
  const message = typeof record.message === "string"
    ? record.message
    : errorField && errorField !== machine
      ? errorField
      : "Request failed";
  return new ApiError(status, machine || "REQUEST_FAILED", message);
}

/**
 * Riley's fixtures and PR #6 put the machine code in `error` and omit `code`.
 * Older tests put a sentence (or a different token) in `error` and the machine
 * code in `code`. A token-shaped `error` wins when `code` is absent or equal.
 */
function machineCode(errorField: string, codeField: string): string {
  const token = /^[A-Za-z0-9_]+$/.test(errorField);
  if (token && (!codeField || errorField === codeField)) return errorField;
  return codeField;
}

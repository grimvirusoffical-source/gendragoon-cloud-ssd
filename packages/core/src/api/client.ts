import { assertNoCredentialFields, BYO_UNSUPPORTED_MESSAGE, BYO_UNVERIFIABLE_MESSAGE } from "../byo.js";
import { assertKeyEnvelope } from "../envelope.js";
import { AccountDeletedError, ApiError, InvalidTokenError, ReauthRequiredError, WorkspaceLockedError, deletionAuthFailure, isAccountDeleted, isInvalidToken, isReauthRequired } from "./errors.js";
import { assertStorageUrlResponse, reauthIsRecent, reauthenticatedAtForDelete } from "../storage.js";
import type {
  AccessResponse,
  BillingStatusResponse,
  ByoChallengeRequest,
  ByoChallengeResponse,
  ByoProofRequest,
  ByoProofResponse,
  CapabilitiesResponse,
  CheckoutResponse,
  CloudFile,
  CreateUploadRequest,
  FileListResponse,
  HealthResponse,
  MergeRequest,
  MergeResponse,
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

  /** Plural path. Poll until `done` or `failed`. */
  deletionStatus(jobId: string): Promise<AccountDeletionStatus> {
    return this.request("GET", `/v2/account/deletions/${encodeURIComponent(jobId)}`);
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

  /** Proposed. See docs/API.md. */
  mergeWorkspaces(body: MergeRequest): Promise<MergeResponse> {
    return this.request("POST", "/v2/workspaces/merge", body);
  }

  /** Proposed lock-resolution delete. Archive remains the live non-destructive removal. */
  deleteWorkspace(id: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/v2/workspaces/${encodeURIComponent(id)}`);
  }

  /** Proposed. Body is provider, endpoint, and bucket fingerprint only. */
  async createByoChallenge(id: string, body: ByoChallengeRequest): Promise<ByoChallengeResponse> {
    assertNoCredentialFields(body);
    return this.request("POST", `/v2/workspaces/${encodeURIComponent(id)}/byo/challenge`, body);
  }

  async submitByoProof(id: string, body: ByoProofRequest): Promise<ByoProofResponse> {
    assertNoCredentialFields(body);
    return this.request("POST", `/v2/workspaces/${encodeURIComponent(id)}/byo/proof`, body);
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
    const headers = new Headers(extraHeaders);
    const token = await this.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
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
  const record = parsed && typeof parsed === "object" ? parsed as { error?: unknown; code?: unknown; jobId?: unknown } : {};
  const code = typeof record.code === "string" ? record.code : "";
  const jobId = typeof record.jobId === "string" ? record.jobId : "";
  if (status === 410 && code === "account_deleted" && jobId) return new AccountDeletedError(jobId);
  if (status === 423 || code === "workspace_lock") return new WorkspaceLockedError();
  if (status === 401 && code === "reauth_required") return new ReauthRequiredError();
  if (status === 401 && code === "invalid_token") return new InvalidTokenError();
  if (status === 422 && code === "byo_provider_unsupported") {
    return new ApiError(422, "byo_provider_unsupported", BYO_UNSUPPORTED_MESSAGE);
  }
  // Fallback only. The server does not send 409 byo_unverifiable.
  // SFTP and the other coming-soon providers return 422 at registration.
  if (status === 409 && code === "byo_unverifiable") {
    return new ApiError(409, "byo_unverifiable", BYO_UNVERIFIABLE_MESSAGE);
  }
  if (status === 404 || code === "PROJECT_FORBIDDEN") {
    return new ApiError(404, "NOT_FOUND", "Not found");
  }
  const message = typeof record.error === "string" ? record.error : "Request failed";
  return new ApiError(status, code || "REQUEST_FAILED", message);
}

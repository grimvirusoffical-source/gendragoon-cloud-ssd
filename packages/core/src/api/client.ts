import type { CreateWorkspaceRequest } from "../workspace-plans.js";
import { parseChatEvents, type ChatMessage, type CreateTeamRequest, type JoinTeamRequest, type ModerationAction, type SharedWorkspace, type Team, type TeamColorChoices, type TeamInvite, type TeamMember, type TeamTierId, type TeamWorkspace, type WorkspaceCard } from "../teams.js";
import { assertNoCredentialFields, BYO_PRESIGNED_URL_MESSAGE, BYO_UNSUPPORTED_MESSAGE, BYO_UNVERIFIABLE_MESSAGE } from "../byo.js";
import { assertKeyEnvelope } from "../envelope.js";
import { AccountDeletedError, ApiError, DeletionNotFoundError, DeletionNotRetryableError,
  TeamOwnerMustTransferError, InvalidTokenError, ReauthRequiredError, SUPPORT_CONTACT, WorkspaceLockedError, deletionAuthFailure, isAccountDeleted, isInvalidToken, isReauthRequired } from "./errors.js";
import { parseWorkspacePrice } from "../policy.js";
import { PROVIDER_BASE_PATH, parseProviderAuthorization, parseProviderBindings, parseProviderGrant, type ProviderAuthorization, type ProviderBinding, type ProviderConnectRequest, type ProviderGrant, type ProviderRevokeResult, type ProviderScope } from "../provider.js";
import { assertStorageUrlResponse, reauthIsRecent, reauthenticatedAtForDelete } from "../storage.js";
import type {
  BillingStatusResponse,
  ByoChallengeResponse,
  ByoProofRequest,
  ByoProofResponse,
  ByoRegisterResponse,
  DeletionSupportResult,
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
  DeletionNotRetryableError,
  TeamOwnerMustTransferError,
  InvalidTokenError,
  ReauthRequiredError,
  SUPPORT_CONTACT,
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

  async listWorkspaces(): Promise<WorkspaceListResponse> {
    const body = await this.request<WorkspaceListResponse>("GET", "/v2/workspaces");
    assertServerPrices(body);
    return body;
  }

  async listProjects(includeArchived = false): Promise<ProjectListResponse> {
    const query = includeArchived ? "?includeArchived=true" : "";
    const body = await this.request<ProjectListResponse>("GET", `/v2/projects${query}`);
    assertServerPrices(body);
    return body;
  }

  async getProject(id: string): Promise<Workspace> {
    const body = await this.request<Workspace>("GET", `/v2/projects/${encodeURIComponent(id)}`);
    assertServerPrices(body);
    return body;
  }

  /** POST /v2/projects/:id/make-hosted. No body. The server returns the new hosted row. */
  makeHosted(id: string): Promise<Record<string, unknown>> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(id)}/make-hosted`);
  }

  /**
   * POST /v2/projects. The free first workspace sends `{ name, intentId }`; every other
   * workspace sends `plans` (and `storage: "custom"` for custom storage). Build the body with
   * `buildCreateWorkspaceRequest` so the rules match the server.
   */
  async createProject(body: CreateWorkspaceRequest): Promise<Record<string, unknown>> {
    const created = await this.request<Record<string, unknown>>("POST", "/v2/projects", body);
    assertServerPrices(created);
    return created;
  }

  /** Resumes the workspace's single plans Checkout, or replaces its plans before payment. */
  checkoutProject(id: string, body?: { plans: NonNullable<CreateWorkspaceRequest["plans"]> }): Promise<CheckoutResponse> {
    return this.request("POST", `/v2/projects/${encodeURIComponent(id)}/checkout`, body);
  }

  // Teams (cloud-ssd feature/teams, docs/API-teams.md)
  teamsCatalog(): Promise<{ tiers: Array<{ id: TeamTierId; name: string; members: number; monthlyCents: number; yearlyCents: number }>; enterprise: { contact: true }; colors: TeamColorChoices }> {
    return this.request("GET", "/v2/teams/catalog");
  }

  checkoutTeamWorkspace(id: string, workspaceId: string): Promise<CheckoutResponse> {
    return this.request("POST", `/v2/teams/${encodeURIComponent(id)}/workspaces/${encodeURIComponent(workspaceId)}/checkout`, {});
  }

  setTeamMemberRole(id: string, memberId: string, role: "member" | "viewer"): Promise<{ memberId: string; role: "member" | "viewer" }> {
    return this.request("POST", `/v2/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}/role`, { role });
  }
  transferTeam(id: string, body: { memberId: string; color: string; ownerShade?: string }): Promise<{ transferred: true; ownerMemberId: string }> {
    return this.request("POST", `/v2/teams/${encodeURIComponent(id)}/transfer`, body);
  }
  deleteTeam(id: string, confirmName: string): Promise<{ deleted: true; canceledSubscriptions: number }> {
    return this.request("POST", `/v2/teams/${encodeURIComponent(id)}/delete`, { confirmName });
  }
  listTeams(): Promise<{ teams: Team[] }> {
    return this.request("GET", "/v2/teams");
  }

  createTeam(body: CreateTeamRequest): Promise<{ team: Team; resumed: boolean; url?: string; totalCents?: number; checkoutError?: string }> {
    return this.request("POST", "/v2/teams", body);
  }

  previewTeamInvite(code: string): Promise<{ teamName: string; memberCount: number; memberLimit: number; colors: TeamColorChoices }> {
    return this.request("POST", "/v2/teams/join/preview", { code });
  }

  joinTeam(body: JoinTeamRequest): Promise<{ teamId: string; alreadyMember: boolean }> {
    return this.request("POST", "/v2/teams/join", body);
  }

  getTeam(id: string): Promise<{ team: Team; colors: TeamColorChoices }> {
    return this.request("GET", `/v2/teams/${encodeURIComponent(id)}`);
  }

  checkoutTeam(id: string, body?: { tier?: TeamTierId; interval?: "month" | "year" }): Promise<CheckoutResponse> {
    return this.request("POST", `/v2/teams/${encodeURIComponent(id)}/checkout`, body ?? {});
  }

  createTeamInvite(id: string, body?: { expiresInHours?: number; maxUses?: number }): Promise<TeamInvite> {
    return this.request("POST", `/v2/teams/${encodeURIComponent(id)}/invites`, body ?? {});
  }

  updateTeamMe(id: string, body: { displayName?: string; color?: string }): Promise<TeamMember> {
    return this.request("PATCH", `/v2/teams/${encodeURIComponent(id)}/me`, body);
  }

  leaveTeam(id: string): Promise<{ left: boolean }> {
    return this.request("POST", `/v2/teams/${encodeURIComponent(id)}/leave`, {});
  }

  teamWorkspaces(id: string): Promise<{ teamWorkspaces: TeamWorkspace[]; sharedWorkspaces: SharedWorkspace[]; subscriptionActive: boolean }> {
    return this.request("GET", `/v2/teams/${encodeURIComponent(id)}/workspaces`);
  }

  createTeamWorkspace(id: string, body: CreateWorkspaceRequest): Promise<{ workspace: TeamWorkspace; url?: string; totalCents?: number }> {
    return this.request("POST", `/v2/teams/${encodeURIComponent(id)}/workspaces`, body);
  }

  shareWorkspace(id: string, workspaceId: string): Promise<{ shared: boolean }> {
    return this.request("POST", `/v2/teams/${encodeURIComponent(id)}/shares`, { workspaceId });
  }

  unshareWorkspace(id: string, workspaceId: string): Promise<{ shared: boolean }> {
    return this.request("DELETE", `/v2/teams/${encodeURIComponent(id)}/shares/${encodeURIComponent(workspaceId)}`);
  }

  teamChat(id: string, after = 0): Promise<{ messages: ChatMessage[]; latestSeq: number; pollAfterMs: number }> {
    return this.request("GET", `/v2/teams/${encodeURIComponent(id)}/chat?after=${after}`);
  }

  postTeamChat(id: string, body: { text?: string; card?: WorkspaceCard & { share?: boolean } }): Promise<{ message: ChatMessage; shared: boolean }> {
    return this.request("POST", `/v2/teams/${encodeURIComponent(id)}/chat`, body);
  }

  reportTeamMessage(id: string, seq: number, body: { category: string; note?: string }): Promise<{ reported: boolean }> {
    return this.request("POST", `/v2/teams/${encodeURIComponent(id)}/chat/${seq}/report`, body);
  }

  deleteTeamMessage(id: string, seq: number, reason: string): Promise<{ ok: boolean }> {
    return this.request("POST", `/v2/teams/${encodeURIComponent(id)}/chat/${seq}/delete`, { reason });
  }

  moderateTeamMember(id: string, memberId: string, action: ModerationAction, body: { reason?: string; until?: number | null }): Promise<{ ok: boolean }> {
    return this.request("POST", `/v2/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}/${action}`, body);
  }

  /** SSE stream; resolves when the stream ends. Falls back to polling when streaming is unavailable. */
  async streamTeamChat(id: string, after: number, onMessages: (messages: ChatMessage[]) => void, signal?: AbortSignal): Promise<"ended" | "removed" | "unsupported"> {
    const response = await this.raw("GET", `/v2/teams/${encodeURIComponent(id)}/chat/stream?after=${after}`, undefined, { Accept: "text/event-stream" });
    if (!response.ok || !response.body || typeof response.body.getReader !== "function") return "unsupported";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    signal?.addEventListener("abort", () => { void reader.cancel(); });
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return "ended";
      const parsed = parseChatEvents(buffer + decoder.decode(value, { stream: true }));
      buffer = parsed.rest;
      if (parsed.messages.length) onMessages(parsed.messages);
      if (parsed.removed) return "removed";
    }
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
   * Short-lived V4 URLs scoped to the workspace prefix.
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
  async deletionStatus(jobId: string, statusToken?: string): Promise<AccountDeletionStatus> {
    const headers = statusToken ? { Authorization: `Bearer ${statusToken}` } : undefined;
    try {
      return await this.request("GET", `/v2/account/deletions/${encodeURIComponent(jobId)}`, undefined, headers);
    } catch (error) {
      // A status token that the server rejects is sign-in, not sign-out.
      // The Firebase-token poll still surfaces InvalidTokenError.
      if (statusToken && isInvalidToken(error)) throw new ReauthRequiredError();
      throw error;
    }
  }

  /** Server stores this envelope and nothing else about the workspace key. */
  /** Connections from other apps (RedX) to this account's workspaces. Never includes keys. */
  async providerBindings(): Promise<ProviderBinding[]> {
    return parseProviderBindings(await this.request<unknown>("GET", `${PROVIDER_BASE_PATH}/bindings`));
  }

  /** One-time connect code (5 minutes) the user pastes into the other app. */
  async createProviderGrant(workspaceId: string, requester: { name: string; host: string }, scopes: ProviderScope[] = ["blobs:rw"]): Promise<ProviderGrant> {
    return parseProviderGrant(await this.request<unknown>("POST", `${PROVIDER_BASE_PATH}/connect/grants`, { workspaceId, scopes, requester }));
  }

  /** Approves a PKCE connect request; the returned code goes back to the requesting app's loopback listener. */
  async authorizeProvider(workspaceId: string, request: ProviderConnectRequest): Promise<ProviderAuthorization> {
    return parseProviderAuthorization(await this.request<unknown>("POST", `${PROVIDER_BASE_PATH}/connect/authorize`, {
      workspaceId,
      scopes: request.scopes,
      requester: request.requester,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
    }));
  }

  /** Revokes the connection and its keys at once. deleteData also removes what the app stored. */
  async revokeProviderBinding(id: string, deleteData = false): Promise<ProviderRevokeResult> {
    const query = deleteData ? "?deleteData=true" : "";
    const body = await this.request<{ revoked?: unknown; purgedObjects?: unknown }>("DELETE", `${PROVIDER_BASE_PATH}/bindings/${encodeURIComponent(id)}${query}`);
    return { revoked: body?.revoked === true, purgedObjects: typeof body?.purgedObjects === "number" ? body.purgedObjects : null };
  }

  async getKeyEnvelope(id: string): Promise<KeyEnvelope> {
    const envelope = await this.request<KeyEnvelope>("GET", `/v2/workspaces/${encodeURIComponent(id)}/key-envelope`);
    assertKeyEnvelope(envelope);
    return envelope;
  }

  async putKeyEnvelope(id: string, envelope: KeyEnvelope): Promise<KeyEnvelope> {
    assertKeyEnvelope(envelope);
    const headers: Record<string, string> = envelope.version <= 1
      ? { "If-None-Match": "*" }
      : { "If-Match": `"${envelope.version - 1}"` };
    return this.request("PUT", `/v2/workspaces/${encodeURIComponent(id)}/key-envelope`, envelope, headers);
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
  async registerByo(id: string, body: ByoRegisterRequest): Promise<ByoRegisterResponse & Record<string, unknown>> {
    assertNoCredentialFields(body);
    const bucketFingerprint = (body.bucketFingerprint || body.hostFingerprint || "").trim();
    const payload = {
      provider: body.provider,
      endpoint: body.endpoint,
      ...(bucketFingerprint ? { bucketFingerprint } : {}),
    };
    const registered = await this.request<ByoRegisterResponse & Record<string, unknown>>("POST", `/v2/workspaces/${encodeURIComponent(id)}/byo/register`, payload);
    assertServerPrices(registered);
    return registered;
  }

  /**
   * POST /v2/account/deletions/:jobId/support-request.
   * No body. Authorization is the status token, so getToken is not called.
   * 404, every 401, other 4xx, a network error, and 5xx return the email fallback.
   * So does any other unexpected status (e.g. 200, 204, 3xx) or a body read error:
   * this method never throws.
   * This method does not call onAuthFailure or clear a session.
   * 409 support_not_needed refreshes GET status with the same token.
   * A failed refresh, a refresh body that is not a status for this job, or a
   * refreshed job that is `failed` (it needs a person) is the same email fallback.
   * 429 retryAfterSec defaults to 60 and is clamped to 1..86400.
   * A missing, empty, or whitespace-only status token is the email fallback
   * with no request, so an empty `Bearer` header is never sent.
   */
  async postDeletionSupport(jobId: string, statusToken: string): Promise<DeletionSupportResult> {
    if (typeof statusToken !== "string" || statusToken.trim() === "") return deletionSupportFallback();
    let status: number;
    let body: unknown;
    try {
      // Inside the try: encodeURIComponent throws URIError on a lone surrogate.
      const path = `/v2/account/deletions/${encodeURIComponent(jobId)}/support-request`;
      const response = await this.raw("POST", path, undefined, { Authorization: `Bearer ${statusToken}` });
      const text = await response.text();
      body = text ? safeJson(text) : null;
      status = response.status;
    } catch {
      // Network error (ApiError 0) or a body that cannot be read.
      return deletionSupportFallback();
    }
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    if (status === 202) {
      const requestId = typeof record.requestId === "string" ? record.requestId : "";
      if (record.status === "received" && requestId) return { kind: "received", requestId };
      return deletionSupportFallback();
    }
    if (status === 429) {
      return { kind: "already_sent", retryAfterSec: supportRetryAfterSec(record.retryAfterSec) };
    }
    if (status === 409 && record.error === "support_not_needed") {
      try {
        const refreshed: unknown = await this.deletionStatus(jobId, statusToken);
        if (!isSupportRefreshStatus(refreshed, jobId) || refreshed.status === "failed") return deletionSupportFallback();
        return { kind: "not_needed", status: refreshed };
      } catch {
        return deletionSupportFallback();
      }
    }
    // Every other status, 4xx/5xx or an unexpected 2xx/3xx, is the email fallback.
    return deletionSupportFallback();
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
  if (machine === "version_mismatch") {
    return new ApiError(status || 412, "version_mismatch", "The key envelope version changed. Fetch it and re-wrap the same key.");
  }
  if (machine === "envelope_exists") {
    return new ApiError(status || 409, "envelope_exists", "This workspace already has a key envelope.");
  }
  if (machine === "byo_external") {
    return new ApiError(status || 409, "byo_external", "This workspace uses its own bucket.");
  }
  if (machine === "team_owner_must_transfer") {
    const raw = (parsed as { teams?: unknown })?.teams;
    const teams = Array.isArray(raw)
      ? raw.filter((t): t is { teamId: string; name: string; otherMembers: number } =>
        !!t && typeof t === "object" && typeof (t as { teamId?: unknown }).teamId === "string")
        .map((t) => ({ teamId: t.teamId, name: typeof t.name === "string" ? t.name : "", otherMembers: Number(t.otherMembers) || 0 }))
      : [];
    return new TeamOwnerMustTransferError(teams);
  }
  if (machine === "deletion_not_retryable") {
    const jobId = typeof record.jobId === "string" ? record.jobId : "";
    return new DeletionNotRetryableError(jobId);
  }
  if (status === 412 || machine === "stale_version" || machine === "stale_generation") {
    return new ApiError(status || 412, machine || "stale_generation", "The saved version is stale. Fetch it again before writing.");
  }
  if (status === 413 || machine === "payload_too_large") {
    return new ApiError(status || 413, "payload_too_large", "The key envelope is larger than 4 KB.");
  }
  if (status === 422 && (machine === "kdf_params_invalid" || machine === "envelope_invalid")) {
    return new ApiError(422, machine, machine === "envelope_invalid"
      ? "Key envelope is unreadable"
      : "Key derivation parameters are not allowed.");
  }
  if (machine === "manifest_generation_required") {
    return new ApiError(status || 400, "manifest_generation_required", "Manifest upload requires the current generation.");
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
 * When `error` is a non-empty string it is the machine code, including a
 * sentence or mixed case. `code` is used only when `error` is absent.
 */
function machineCode(errorField: string, codeField: string): string {
  if (errorField.length > 0) return errorField;
  return codeField;
}

function deletionSupportFallback(): DeletionSupportResult {
  return { kind: "fallback", contact: SUPPORT_CONTACT };
}

const SUPPORT_RETRY_AFTER_DEFAULT_SEC = 60;
const SUPPORT_RETRY_AFTER_MAX_SEC = 86_400;

/** 429 retryAfterSec: missing, non-finite or <= 0 is 60; otherwise clamped to 1..86400. */
function supportRetryAfterSec(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return SUPPORT_RETRY_AFTER_DEFAULT_SEC;
  return Math.min(SUPPORT_RETRY_AFTER_MAX_SEC, Math.max(1, value));
}

const SUPPORT_REFRESH_STATES: ReadonlySet<string> = new Set(["queued", "running", "done", "failed"]);

/** A refresh after 409 must be a deletion status object for this job with a known state. */
function isSupportRefreshStatus(value: unknown, jobId: string): value is AccountDeletionStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.jobId === jobId && typeof record.status === "string" && SUPPORT_REFRESH_STATES.has(record.status);
}

/**
 * Workspace list items and create `project` objects must carry `isFree`,
 * `monthlyPriceCents`, and `grandfathered`. The response envelope is left
 * unchanged. A register body that only repeats `isFree` is not a list item.
 */
function assertServerPrices(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const record = body as Record<string, unknown>;
  const items: unknown[] = [];
  if (Array.isArray(record.workspaces)) items.push(...record.workspaces);
  if (Array.isArray(record.projects)) items.push(...record.projects);
  if (record.project && typeof record.project === "object") items.push(record.project);
  for (const item of items) parseWorkspacePrice(item);
}

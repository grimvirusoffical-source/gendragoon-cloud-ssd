import { assertNoCredentialFields } from "../byo.js";
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
} from "./types.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

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
    return this.request("GET", `/v3/cloud/${encodeURIComponent(workspaceId)}/files${query}`);
  }

  createUpload(workspaceId: string, body: CreateUploadRequest): Promise<UploadStatus> {
    return this.request("POST", `/v3/cloud/${encodeURIComponent(workspaceId)}/uploads`, body);
  }

  uploadStatus(workspaceId: string, uploadId: string): Promise<UploadStatus> {
    return this.request("GET", `/v3/cloud/${encodeURIComponent(workspaceId)}/uploads/${encodeURIComponent(uploadId)}`);
  }

  async uploadChunk(workspaceId: string, uploadId: string, index: number, bytes: Uint8Array, sha256: string): Promise<{ saved: boolean; index: number }> {
    return this.request(
      "PUT",
      `/v3/cloud/${encodeURIComponent(workspaceId)}/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`,
      bytes,
      { "content-type": "application/octet-stream", "x-chunk-sha256": sha256 },
    );
  }

  finalizeUpload(workspaceId: string, uploadId: string): Promise<{ saved: boolean; fileId?: string }> {
    return this.request("POST", `/v3/cloud/${encodeURIComponent(workspaceId)}/uploads/${encodeURIComponent(uploadId)}/finalize`);
  }

  cancelUpload(workspaceId: string, uploadId: string): Promise<{ cancelled: boolean }> {
    return this.request("DELETE", `/v3/cloud/${encodeURIComponent(workspaceId)}/uploads/${encodeURIComponent(uploadId)}`);
  }

  deleteFile(workspaceId: string, fileId: string): Promise<{ deleted: boolean }> {
    return this.request("DELETE", `/v3/cloud/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(fileId)}`);
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
    return this.raw("GET", `/v3/cloud/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(file.id)}/download`);
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
  const record = parsed && typeof parsed === "object" ? parsed as { error?: unknown; code?: unknown } : {};
  const code = typeof record.code === "string" ? record.code : "";
  if (status === 404 || code === "PROJECT_FORBIDDEN") {
    return new ApiError(404, "NOT_FOUND", "Not found");
  }
  const message = typeof record.error === "string" ? record.error : "Request failed";
  return new ApiError(status, code || "REQUEST_FAILED", message);
}

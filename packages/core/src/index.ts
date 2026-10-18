export {
  TOMBSTONE_TTL_MS,
  commitManifest,
  manifestSyncedKey,
  manifestUploadRequest,
  manifestVersionKey,
  mergeManifestFiles,
  mergeSealedManifest,
  putManifestBytes,
  readLastSyncedVersion,
  readManifestVersion,
  rememberManifestVersion,
} from "./manifest-cas.js";
export type { ManifestMergeDocument, ManifestMergeFile } from "./manifest-cas.js";
export { replaceEncryptedObject, uploadEncryptedObject } from "./upload.js";
export { planSummary } from "./policy.js";
export type {
  ProjectStatus,
  ProjectFeeStatus,
  WorkspaceKind,
  WorkspaceRecord,
  WorkspaceStorage,
  LockAssessment,
  PlanSummary,
} from "./policy.js";

export { foreignAccount, renderableWorkspaces, foreignWorkspaceStatus, hidesWorkspaceExistence } from "./ownership.js";
export type { SessionIdentity, HttpErrorLike } from "./ownership.js";

export {
  LAUNCH_BYO_PROVIDERS,
  COMING_SOON_BYO_PROVIDERS,
  LATER_BYO_PROVIDERS,
  CHALLENGE_PREFIX,
  CHALLENGE_URL_MAX_MS,
  BYO_UNSUPPORTED_MESSAGE,
  BYO_UNVERIFIABLE_MESSAGE,
  BYO_PRESIGNED_URL_MESSAGE,
  isLaunchProvider,
  byoErrorMessage,
  assertNoCredentialFields,
  bucketFingerprint,
  normalizeEndpoint,
  toServerByoRegistration,
  challengeObjectKey,
  registrationRequiresChallenge,
  performOwnershipChallenge,
  assertChallengeGetUrl,
  byoMayActivate,
  presignChallengeGet,
  createSigV4ChallengeWriter,
} from "./byo.js";
export type {
  S3ChallengeCredentials,
  ByoProviderId,
  LaterByoProviderId,
  StorageProvider,
  StorageProviderByo,
  StorageProviderManaged,
  DeviceByoCredentials,
  ServerByoRegistration,
  ByoChallenge,
  ByoProof,
  ByoObjectWriter,
} from "./byo.js";

export { SORT_CATEGORIES, isSortCategory, extensionOf, categorize, applySortOverride } from "./sorting.js";
export type { SortCategory, SortOverrides, SortInput } from "./sorting.js";

export { EMPTY_SETTINGS, validateSettings, MemorySettingsStore, updateSortMapping } from "./settings.js";
export type { Settings, SettingsStore } from "./settings.js";

export { collisionLabel, planIncomingPath, planMerge, sourceDeletionAllowed, mergePhase } from "./merge.js";
export type { MergeEntry, PlannedMergeEntry, MergePhase } from "./merge.js";

export {
  kindFromName,
  assertNotInsideApp,
  treeNode,
  actionsForMode,
  freshUploadState,
  requireRevision,
  requireIdle,
  selectWorkspace,
  enqueueSelection,
} from "./tree.js";
export type { NodeKind, BrowserMode, TreeNode, BrowserActions, SourceRecord, JobState, UploadJob, UploadWorkspaceState } from "./tree.js";

export { CHUNK_BYTES, MAX_FILE_BYTES, PACKAGE_FORMAT, safeFileName, planChunks, transferMetadata } from "./transfer.js";
export type { TransferKind, ChunkPlan, TransferMetadata } from "./transfer.js";

export { libraryDestination, libraryKey } from "./library.js";
export type { LibraryDestination } from "./library.js";

export {
  AccountDeletedError,
  ApiError,
  DeletionNotFoundError,
  DeletionNotRetryableError,
  InvalidTokenError,
  ReauthRequiredError,
  SUPPORT_CONTACT,
  WorkspaceLockedError,
  deletionAuthFailure,
  isAccountDeleted,
  isInvalidToken,
  isReauthRequired,
  GenDragoonClient,
} from "./api/client.js";
export type { ClientOptions } from "./api/client.js";
export {
  accountFromAssessment,
  reduceAccount,
  isWorkspaceLockError,
  applyApiFailure,
  viewAfterFailure,
  deleteAccountAndWipe,
  dismissAccountDeletion,
  dismissDeletion,
  resumeAccountDeletion,
  retryDeletion,
} from "./account.js";
export type { AccountPhase, AccountLockReason, AccountState, AccountEvent, DeletionAuthSignal } from "./account.js";
export {
  SIGNED_URL_MAX_MS,
  REAUTH_WINDOW_MS,
  reauthIsRecent,
  authTimeMsFromIdToken,
  accountUidFromIdToken,
  reauthenticatedAtForDelete,
  storageOperations,
  assertStorageUrlResponse,
  putSignedObject,
} from "./storage.js";
export {
  LIBRARY_OBJECT_ID,
  MemorySecretStore,
  workspaceKeyId,
  byoSecretId,
  createWorkspaceKey,
  importWorkspaceKey,
  loadOrCreateWorkspaceKey,
  wipeWorkspaceKeys,
  sealNamedFile,
  openNamedFile,
  sealLibrary,
  openLibrary,
  sealStream,
  sealBytes,
  openBytes,
  bytesToBase64,
  bytesToBase64Url,
  base64UrlToBytes,
  base64ToBytes,
} from "./seal.js";
export {
  PASSPHRASE_LOSS_WARNING,
  KDF_MAX_ITERATIONS,
  KDF_MAX_MEMORY_KIB,
  createKeyEnvelope,
  unwrapWorkspaceKey,
  assertKeyEnvelope,
  openWorkspaceKey,
  publishKeyEnvelope,
  establishWorkspaceKey,
  rewrapWorkspaceKey,
} from "./envelope.js";
export type { SecretStore, SecureStore, SealedName, LibraryManifest, ManifestTombstone } from "./seal.js";
export { MemorySecretStore as MemorySecureStore } from "./seal.js";
export type {
  HealthResponse,
  CapabilitiesResponse,
  BillingStatusResponse,
  PricingResponse,
  Workspace,
  ProjectPolicy,
  WorkspaceListResponse,
  ProjectListResponse,
  CheckoutResponse,
  UploadStatus,
  CloudFile,
  FileListResponse,
  CreateUploadRequest,
  WorkspaceFeeCheckout,
  MergePreviewResponse,
  MergeRequest,
  MergeResponse,
  ByoRegisterRequest,
  ByoChallengeRequest,
  ByoChallengeResponse,
  ByoProofRequest,
  ByoProofResponse,
  AccessResponse,
  StorageOp,
  StorageMode,
  StorageUrlRequest,
  StorageObjectUrl,
  StorageLink,
  StorageUrlResponse,
  Argon2idKdf,
  ScryptKdf,
  DeleteAccountRequest,
  DeleteAccountAccepted,
  AccountDeletionStatus,
  KeyEnvelope,
} from "./api/types.js";

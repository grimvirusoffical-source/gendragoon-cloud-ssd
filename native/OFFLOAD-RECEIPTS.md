# Mac offload receipts — 0.22.3 (40)

Full cloud readback, SHA-256 comparison and restored-source metadata verification remain mandatory before moving an original. This update changes bookkeeping, not encryption or the storage destination.

The final original move holds the library lock and checks immutable archive identity, rather than comparing every mutable catalog field after Finder has already moved the source. A local refresh may update display/revision metadata without falsely invalidating a completed move.

A private, durable OffloadReceipts record is written before OS Trash. Success records a separate moved result. Failure to save the library after a confirmed move is reported as completed offload with pending local bookkeeping, not a request to upload a missing original again. Unconfirmed OS results remain unconfirmed; no permanent deletion fallback exists.

The queue retains the verified cloud item key even when its requested original offload is incomplete, and uses an explicit offload diagnostic rather than the generic helper failure. Older ambiguous jobs are not silently rewritten as successful.

Validation: eight new disposable-file receipt tests and 121 focused upload, launch, readback and remote-range tests passed on the connected Mac with a real-path temporary directory. Real user files are not used in these tests. The existing crypto submodule is unchanged.

The remote-reader CLI also suppresses bytecode writes before importing any bundled helpers, preserving the signed resource seal when invoked directly. The Windows/Linux fixture now explicitly freezes both encryption and offload choices.

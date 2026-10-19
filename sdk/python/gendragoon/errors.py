"""Errors raised by the SDK."""
from __future__ import annotations


class GendragoonError(Exception):
    pass


class APIError(GendragoonError):
    """A non-2xx answer. ``code`` is the server's machine code, such as ``"quota_exceeded"``."""

    def __init__(self, status: int, code: str = "", retry_after: int = 0):
        super().__init__(f"gendragoon: {status} {code}")
        self.status = status
        self.code = code
        self.retry_after = retry_after

    @property
    def not_found(self) -> bool:
        return self.status == 404

    @property
    def precondition_failed(self) -> bool:
        return self.status == 412 or self.code in ("precondition_failed", "version_mismatch")

    @property
    def quota_exceeded(self) -> bool:
        return self.status == 507 or self.code == "quota_exceeded"

    @property
    def unauthorized(self) -> bool:
        return self.status == 401

    @property
    def rate_limited(self) -> bool:
        return self.status == 429


class ChecksumError(GendragoonError):
    def __init__(self):
        super().__init__("gendragoon: checksum mismatch")


class CorruptError(GendragoonError):
    def __init__(self):
        super().__init__("gendragoon: data is corrupt or was encrypted with another key")


class WrongPassphraseError(GendragoonError):
    def __init__(self):
        super().__init__("gendragoon: the recovery passphrase did not unlock this key")


class LockedError(GendragoonError):
    def __init__(self):
        super().__init__("gendragoon: master key not unlocked")

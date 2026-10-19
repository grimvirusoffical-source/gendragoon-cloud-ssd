using System;

namespace Gendragoon.Sdk
{
    /// <summary>A non-2xx answer. Code is the server's machine code, such as "quota_exceeded".</summary>
    public sealed class ApiException : Exception
    {
        public int Status { get; }
        public string Code { get; }
        public int RetryAfterSeconds { get; }
        public ApiException(int status, string code, int retryAfter = 0) : base($"gendragoon: {status} {code}")
        {
            Status = status; Code = code; RetryAfterSeconds = retryAfter;
        }
        public bool NotFound => Status == 404;
        public bool PreconditionFailed => Status == 412 || Code == "precondition_failed" || Code == "version_mismatch";
        public bool QuotaExceeded => Status == 507 || Code == "quota_exceeded";
        public bool Unauthorized => Status == 401;
        public bool RateLimited => Status == 429;
    }

    public sealed class ChecksumException : Exception { public ChecksumException() : base("gendragoon: checksum mismatch") { } }
    public sealed class CorruptException : Exception { public CorruptException() : base("gendragoon: data is corrupt or was encrypted with another key") { } }
    public sealed class WrongPassphraseException : Exception { public WrongPassphraseException() : base("gendragoon: the recovery passphrase did not unlock this key") { } }
    public sealed class LockedException : Exception { public LockedException() : base("gendragoon: master key not unlocked") { } }
}

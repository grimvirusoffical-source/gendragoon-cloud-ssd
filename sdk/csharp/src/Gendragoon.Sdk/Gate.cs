using System;

namespace Gendragoon.Sdk
{
    /// <summary>Rotten Apple developer unlock levels (docs/SDK_LEVELS.md: L0 Applicant, L1 Starter, L2 Established,
    /// L3 Trusted, L4 By approval). data.storage and gendragoon are L2 services.</summary>
    public enum Level { L0 = 0, L1 = 1, L2 = 2, L3 = 3, L4 = 4 }

    public enum Risk { Read, Write, Credential, Destructive, BulkDestructive, Key, KeyExport, Sharing }

    /// <summary>One entry of the shared operation table (spec/operations.json).</summary>
    public sealed class Operation
    {
        public string Id { get; }
        public Level Level { get; }
        /// <summary>Rotten Apple service id: "data.storage" or "gendragoon".</summary>
        public string Service { get; }
        public Risk Risk { get; }
        /// <summary>"app" (API key), "user" (signed-in account) or "local" (no network).</summary>
        public string Context { get; }
        public string Method { get; }
        public string Path { get; }
        public string Scope { get; }
        public string Summary { get; }

        public Operation(string id, Level level, string service, Risk risk, string context, string method, string path, string scope, string summary)
        {
            Id = id; Level = level; Service = service; Risk = risk; Context = context; Method = method; Path = path; Scope = scope; Summary = summary;
        }
    }

    /// <summary>Thrown when the gate refuses an operation.</summary>
    public sealed class LevelException : UnauthorizedAccessException
    {
        public Operation Operation { get; }
        public Level Allowed { get; }
        public LevelException(Operation op, Level allowed)
            : base($"gendragoon: {op.Id} needs {op.Level} ({op.Risk}); this client allows up to {allowed}")
        {
            Operation = op; Allowed = allowed;
        }
    }

    /// <summary>Decides whether an operation may run; throws to refuse.</summary>
    public delegate void Gate(Operation op);

    public static partial class Operations
    {
        public const Level DefaultMaxLevel = Level.L3;
        /// <summary>A host (the Rotten Apple launcher) sets this to cap the level. It can only lower the cap.</summary>
        public const string MaxLevelEnv = "GENDRAGOON_SDK_MAX_LEVEL";

        public static Operation Get(string id)
        {
            foreach (var o in All) if (o.Id == id) return o;
            throw new ArgumentException("gendragoon: unknown operation " + id);
        }

        public static Level ParseLevel(string value)
        {
            var t = value.Trim().ToUpperInvariant();
            if (t.StartsWith("L")) t = t.Substring(1);
            if (t.Length == 1 && t[0] >= '0' && t[0] <= '4') return (Level)(t[0] - '0');
            throw new FormatException($"gendragoon: unknown level \"{value}\"");
        }

        /// <summary>Allows operations at or below max, lowered further by GENDRAGOON_SDK_MAX_LEVEL. An unreadable value locks to L0.</summary>
        public static Gate LevelGate(Level max = DefaultMaxLevel)
        {
            var eff = max;
            var env = Environment.GetEnvironmentVariable(MaxLevelEnv);
            if (env != null)
            {
                try { var l = ParseLevel(env); if (l < eff) eff = l; }
                catch (FormatException) { eff = Level.L0; }
            }
            return op => { if (op.Level > eff) throw new LevelException(op, eff); };
        }
    }
}

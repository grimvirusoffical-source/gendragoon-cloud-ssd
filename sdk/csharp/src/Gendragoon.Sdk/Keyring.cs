using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Gendragoon.Sdk
{
    /// <summary>The unlocked master key, held in memory only.</summary>
    public sealed class Keyring
    {
        readonly Client c;
        readonly object gate = new object();
        byte[]? mk;

        public Keyring(Client client) { c = client; }
        public bool Unlocked { get { lock (gate) return mk != null; } }
        public override string ToString() => $"Keyring(unlocked={Unlocked})";

        /// <summary>Wipes the master key from memory.</summary>
        public void Lock() { lock (gate) { Bytes.Wipe(mk); mk = null; } }
        internal byte[] Master() { lock (gate) return mk ?? throw new LockedException(); }
        void Set(byte[] k) { lock (gate) { Bytes.Wipe(mk); mk = k; } }

        /// <summary>Reads the binding's key envelope and opens it. Level L2, risk key.</summary>
        public async Task UnlockAsync(string passphrase, CancellationToken ct = default)
        {
            c.Check("crypto.unlock");
            var env = await c.GetKeyEnvelopeAsync(ct).ConfigureAwait(false);
            Set(await Task.Run(() => Crypto.UnwrapMasterKey(env, passphrase), ct).ConfigureAwait(false));
        }

        /// <summary>Generates a master key and stores its envelope (create-only). Level L3, risk key.</summary>
        public async Task CreateAsync(string passphrase, CancellationToken ct = default)
        {
            c.Check("keyEnvelope.create");
            var k = Bytes.Random(Crypto.KeyBytes);
            var env = await Task.Run(() => Crypto.WrapMasterKey(k, passphrase), ct).ConfigureAwait(false);
            try { await c.PutKeyEnvelope("keyEnvelope.create", env, new Dictionary<string, string> { ["If-None-Match"] = "*" }, ct).ConfigureAwait(false); }
            catch (Exception e)
            {
                Bytes.Wipe(k);
                // The server answers 409 envelope_exists; every SDK reports it as a lost compare-and-swap.
                if (e is ApiException a && a.Code == "envelope_exists") throw new ApiException(412, "envelope_exists");
                throw;
            }
            Set(k);
        }

        /// <summary>Re-wraps the master key under a new passphrase (compare-and-swap on the version). Level L3, risk key.</summary>
        public async Task ChangePassphraseAsync(string newPassphrase, CancellationToken ct = default)
        {
            c.Check("keyEnvelope.replace");
            var k = Master();
            var cur = await c.GetKeyEnvelopeAsync(ct).ConfigureAwait(false);
            var env = await Task.Run(() => Crypto.WrapMasterKey(k, newPassphrase, null, cur.Version + 1), ct).ConfigureAwait(false);
            await c.PutKeyEnvelope("keyEnvelope.replace", env, new Dictionary<string, string> { ["If-Match"] = "\"" + cur.Version + "\"" }, ct).ConfigureAwait(false);
        }

        /// <summary>Loads a master key handed over by the host (for example the Rotten Apple launcher). Level L2, risk key.</summary>
        public void ImportMasterKey(byte[] key)
        {
            c.Check("crypto.importMasterKey");
            if (key.Length != Crypto.KeyBytes) throw new ArgumentException("gendragoon: master key must be 32 bytes");
            Set((byte[])key.Clone());
        }

        /// <summary>A copy of the raw master key. Level L4, risk key-export: the default gate refuses it.</summary>
        public byte[] ExportMasterKey()
        {
            c.Check("crypto.exportMasterKey");
            return (byte[])Master().Clone();
        }
    }
}

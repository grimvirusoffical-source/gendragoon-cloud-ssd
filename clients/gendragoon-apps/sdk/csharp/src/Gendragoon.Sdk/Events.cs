using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;

namespace Gendragoon.Sdk
{
    public enum ChangeType { ManifestCreated, ManifestUpdated, ManifestDeleted, UsageChanged, BindingRevoked }

    public sealed class ChangeEvent
    {
        public ChangeType Type;
        public string? Key, Generation;
        public Usage? Usage;
        /// <summary>The wire name used by every SDK: "manifest.created", "usage.changed" and so on.</summary>
        public string Name => Type switch
        {
            ChangeType.ManifestCreated => "manifest.created", ChangeType.ManifestUpdated => "manifest.updated",
            ChangeType.ManifestDeleted => "manifest.deleted", ChangeType.UsageChanged => "usage.changed", _ => "binding.revoked",
        };
    }

    public sealed class WatchOptions
    {
        /// <summary>Between /usage polls; at least one second.</summary>
        public TimeSpan Interval = TimeSpan.FromSeconds(5);
        /// <summary>Full manifest listing even when changeSeq did not move.</summary>
        public TimeSpan ResyncEvery = TimeSpan.FromMinutes(10);
        /// <summary>Only manifest events for these keys (for example one drive's ManifestKey).</summary>
        public ICollection<string>? Keys;
    }

    /// <summary>Change events by polling. The server has no webhook or stream (Capabilities.EventsPoll only), so Watch
    /// polls /usage for changeSeq and lists manifests only when it moved.</summary>
    public static class Events
    {
        /// <summary>Yields changes until cancelled or the binding is revoked. The first poll records the current state and
        /// yields nothing. Level L2, risk read.</summary>
        public static async IAsyncEnumerable<ChangeEvent> WatchAsync(Client c, WatchOptions? o = null, [EnumeratorCancellation] CancellationToken ct = default)
        {
            c.Check("events.watch");
            o ??= new WatchOptions();
            var interval = o.Interval < TimeSpan.FromSeconds(1) ? TimeSpan.FromSeconds(1) : o.Interval;
            var filter = o.Keys != null && o.Keys.Count > 0 ? new HashSet<string>(o.Keys) : null;
            Dictionary<string, string?>? seen = null;
            Usage? last = null;
            var lastList = DateTimeOffset.MinValue;
            while (!ct.IsCancellationRequested)
            {
                Usage? u = null;
                bool revoked = false;
                try { u = await c.UsageAsync(ct).ConfigureAwait(false); }
                catch (ApiException e) when (e.Unauthorized) { revoked = true; }
                catch (Exception e) when (!(e is OperationCanceledException)) { }
                if (revoked) { yield return new ChangeEvent { Type = ChangeType.BindingRevoked }; yield break; }
                if (u != null)
                {
                    if (last != null && (u.UsedBytes != last.UsedBytes || u.ObjectCount != last.ObjectCount || u.QuotaBytes != last.QuotaBytes))
                        yield return new ChangeEvent { Type = ChangeType.UsageChanged, Usage = u };
                    if (last == null || u.ChangeSeq != last.ChangeSeq || DateTimeOffset.UtcNow - lastList >= o.ResyncEvery)
                    {
                        Dictionary<string, string?>? now = null;
                        try
                        {
                            now = new Dictionary<string, string?>(StringComparer.Ordinal);
                            foreach (var it in await c.AllManifestsAsync(ct).ConfigureAwait(false)) if (filter == null || filter.Contains(it.Id)) now[it.Id] = it.Generation;
                            lastList = DateTimeOffset.UtcNow;
                        }
                        catch (Exception e) when (!(e is OperationCanceledException)) { now = null; }
                        if (now != null)
                        {
                            if (seen != null)
                            {
                                foreach (var k in now.Keys.OrderBy(k => k, StringComparer.Ordinal))
                                {
                                    if (!seen.TryGetValue(k, out var g)) yield return new ChangeEvent { Type = ChangeType.ManifestCreated, Key = k, Generation = now[k] };
                                    else if (g != now[k]) yield return new ChangeEvent { Type = ChangeType.ManifestUpdated, Key = k, Generation = now[k] };
                                }
                                foreach (var k in seen.Keys.OrderBy(k => k, StringComparer.Ordinal)) if (!now.ContainsKey(k)) yield return new ChangeEvent { Type = ChangeType.ManifestDeleted, Key = k };
                            }
                            seen = now;
                        }
                    }
                    last = u;
                }
                try { await Task.Delay(interval, ct).ConfigureAwait(false); } catch (OperationCanceledException) { yield break; }
            }
        }
    }
}

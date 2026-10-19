using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;

namespace Gendragoon.Sdk.Tests
{
    [AttributeUsage(AttributeTargets.Method)]
    sealed class TestAttribute : Attribute { public bool NeedsServer; }

    /// <summary>A dependency-free runner, so the same tests run under Unity's .NET profile and plain dotnet.
    /// Usage: dotnet run [-- filter], or dotnet run -- --interop [--init] for sdk/contract/run.sh. The contract tests need GD_SDK_BASE or GD_DEV_SERVER.</summary>
    static class Harness
    {
        static async Task<int> Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--interop") return await Interop.Run(args.Contains("--init")).ConfigureAwait(false);
            var filter = args.FirstOrDefault();
            string? baseUrl = null;
            using var server = DevServer.StartIfConfigured(out baseUrl);
            Contract.Base = baseUrl;
            int pass = 0, fail = 0, skip = 0;
            var tests = typeof(Harness).Assembly.GetTypes().SelectMany(t => t.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
                .Select(m => (m, a: m.GetCustomAttribute<TestAttribute>())).Where(x => x.a != null).OrderBy(x => x.m.DeclaringType!.Name).ThenBy(x => x.m.Name);
            foreach (var (m, a) in tests)
            {
                var name = m.DeclaringType!.Name + "." + m.Name;
                if (filter != null && !name.Contains(filter)) continue;
                if (a!.NeedsServer && baseUrl == null) { Console.WriteLine($"SKIP {name} (set GD_SDK_BASE or GD_DEV_SERVER)"); skip++; continue; }
                var sw = Stopwatch.StartNew();
                try
                {
                    var r = m.Invoke(null, null);
                    if (r is Task t) await t.ConfigureAwait(false);
                    Console.WriteLine($"PASS {name} ({sw.ElapsedMilliseconds} ms)"); pass++;
                }
                catch (Exception e)
                {
                    var inner = e is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : e;
                    Console.WriteLine($"FAIL {name}: {inner}"); fail++;
                }
            }
            Console.WriteLine($"{pass} passed, {fail} failed, {skip} skipped");
            return fail == 0 ? 0 : 1;
        }
    }

    static class Assert
    {
        public static void True(bool c, string what = "condition") { if (!c) throw new Exception("expected " + what); }
        public static void Equal<T>(T want, T got, string what = "value")
        {
            if (!EqualityComparer<T>.Default.Equals(want, got)) throw new Exception($"{what}: want {want}, got {got}");
        }
        public static TE Throws<TE>(Action f) where TE : Exception
        {
            try { f(); } catch (TE e) { return e; } catch (Exception e) { throw new Exception($"expected {typeof(TE).Name}, got {e.GetType().Name}: {e.Message}"); }
            throw new Exception($"expected {typeof(TE).Name}");
        }
        public static async Task<TE> ThrowsAsync<TE>(Func<Task> f) where TE : Exception
        {
            try { await f().ConfigureAwait(false); } catch (TE e) { return e; } catch (Exception e) { throw new Exception($"expected {typeof(TE).Name}, got {e.GetType().Name}: {e.Message}"); }
            throw new Exception($"expected {typeof(TE).Name}");
        }
    }

    sealed class DevServer : IDisposable
    {
        readonly Process? p;
        DevServer(Process? p) { this.p = p; }

        public static DevServer StartIfConfigured(out string? baseUrl)
        {
            baseUrl = Environment.GetEnvironmentVariable("GD_SDK_BASE");
            var script = Environment.GetEnvironmentVariable("GD_DEV_SERVER");
            if (baseUrl != null || script == null) return new DevServer(null);
            var psi = new ProcessStartInfo("node") { RedirectStandardInput = true, RedirectStandardOutput = true, UseShellExecute = false };
            psi.ArgumentList.Add(script); psi.ArgumentList.Add("--exit-with-stdin");
            psi.Environment["PROVIDER_V1_ENABLED"] = "true";
            var p = Process.Start(psi)!;
            baseUrl = Json.Obj(p.StandardOutput.ReadLine() ?? "{}").S("base");
            return new DevServer(p);
        }

        public void Dispose()
        {
            if (p == null) return;
            try { p.StandardInput.Close(); if (!p.WaitForExit(10000)) p.Kill(); } catch (InvalidOperationException) { }
        }
    }
}

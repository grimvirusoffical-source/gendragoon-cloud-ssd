using System;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;

namespace Gendragoon.Sdk.Tests
{
    /// <summary>The .NET participant of the cross-language interop check (sdk/contract/run.sh).</summary>
    static class Interop
    {
        public static async Task<int> Run(bool init)
        {
            var lang = Environment.GetEnvironmentVariable("GD_SDK_LANG") ?? "csharp";
            var c = new Client(Environment.GetEnvironmentVariable("GD_SDK_BASE")!, Environment.GetEnvironmentVariable("GD_SDK_KEY")!);
            var keys = new Keyring(c);
            var pass = Environment.GetEnvironmentVariable("GD_SDK_PASSPHRASE")!;
            if (init) await keys.CreateAsync(pass); else await keys.UnlockAsync(pass);
            var d = new Drive(c, "interop", keys);
            var verified = new List<object?>();
            foreach (var e in await d.ListAsync(""))
            {
                if (e.Folder || !e.Name.StartsWith("from-")) continue;
                var who = e.Name.Substring(5);
                if (who.EndsWith(".txt")) who = who.Substring(0, who.Length - 4);
                var got = Encoding.UTF8.GetString(await d.ReadFileAsync(e.Path));
                if (got != $"hello from {who}\n") { Console.Error.WriteLine($"{e.Path}: unexpected content"); return 1; }
                verified.Add(who);
            }
            await d.WriteFileAsync($"from-{lang}.txt", Encoding.UTF8.GetBytes($"hello from {lang}\n"));
            Console.WriteLine(Json.Write(new Dictionary<string, object?> { ["lang"] = lang, ["verified"] = verified }));
            return 0;
        }
    }
}

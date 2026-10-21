#nullable enable
using System.IO;
using UnityEngine;

namespace Gendragoon.Unity
{
    /// <summary>Where the binding's API key is kept between sessions.</summary>
    public interface ICredentialStore
    {
        string? Load();
        void Save(string apiKey);
        void Clear();
    }

    /// <summary>Keeps the API key in a file under Application.persistentDataPath, which the operating system protects like the
    /// rest of the game's data. Replace it with the platform keychain or keystore where one is available.</summary>
    public sealed class FileCredentialStore : ICredentialStore
    {
        readonly string path;

        public FileCredentialStore(string fileName = "gendragoon.key")
        {
            path = Path.Combine(Application.persistentDataPath, fileName);
        }

        public string? Load() => File.Exists(path) ? File.ReadAllText(path).Trim() : null;

        public void Save(string apiKey)
        {
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, apiKey);
            if (File.Exists(path)) File.Delete(path);
            File.Move(tmp, path);
        }

        public void Clear() { if (File.Exists(path)) File.Delete(path); }
    }
}

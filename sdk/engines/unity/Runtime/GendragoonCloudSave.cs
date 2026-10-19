#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Gendragoon.Sdk;
using UnityEngine;

namespace Gendragoon.Unity
{
    /// <summary>
    /// Cloud save slots on GenDragoon Cloud SSD. Add it to a GameObject, connect once with a connect code the player
    /// copies from GenDragoon (or with a connect link), then save and load slots. Slots live in one encrypted drive;
    /// the master key is unlocked with the player's recovery passphrase, or handed over by the host launcher.
    /// </summary>
    /// <remarks>
    /// Every call goes through the SDK's level gate (docs/LEVELS.md). Deleting single slots is allowed by default;
    /// bulk deletion and key export are not.
    /// </remarks>
    [AddComponentMenu("GenDragoon/Cloud Save")]
    public sealed class GendragoonCloudSave : MonoBehaviour
    {
        [Tooltip("Provider API base URL, for example https://api.gendragoon.com/provider/v1")]
        [SerializeField] string baseUrl = "https://api.gendragoon.com/provider/v1";

        [Tooltip("Name the player sees for this game in their connected apps.")]
        [SerializeField] string appName = "";

        [Tooltip("Drive that holds the save slots.")]
        [SerializeField] string driveName = "saves";

        [Tooltip("Folder inside the drive for the slots.")]
        [SerializeField] string slotFolder = "slots";

        [Tooltip("Highest operation level this component may use (L2 covers saving, loading and deleting single slots).")]
        [SerializeField] Level maxLevel = Level.L2;

        /// <summary>Replace before calling ConnectAsync to keep the API key somewhere else.</summary>
        public ICredentialStore Credentials { get; set; } = null!;

        Client? client;
        Keyring? keys;
        Drive? drive;

        public bool Connected => client != null;
        public bool Unlocked => keys != null && keys.Unlocked;
        public Client? Client => client;

        void Awake()
        {
            Credentials ??= new FileCredentialStore();
            if (string.IsNullOrEmpty(appName)) appName = Application.productName;
            var saved = Credentials.Load();
            if (!string.IsNullOrEmpty(saved)) Attach(saved!);
        }

        ClientOptions Options => new ClientOptions { Gate = Operations.LevelGate(maxLevel), UserAgent = "unity/" + Application.unityVersion };

        void Attach(string apiKey)
        {
            client = new Client(baseUrl, apiKey, Options);
            keys = new Keyring(client);
            drive = null;
        }

        /// <summary>Redeems a one-time connect code (gdpg_…) and remembers the binding.</summary>
        public async Task ConnectAsync(string connectCode, CancellationToken ct = default)
        {
            var conn = await new Connector(baseUrl, Options).RedeemGrantAsync(connectCode, new ClientInfo(appName, SystemInfo.deviceName), ct);
            Credentials.Save(conn.ApiKey);
            Attach(conn.ApiKey);
        }

        /// <summary>Connects through the browser with a connect link and a loopback redirect (desktop only).</summary>
        public async Task ConnectWithBrowserAsync(TimeSpan? timeout = null, CancellationToken ct = default)
        {
            var p = Pkce.Create();
            using var lb = Loopback.Listen(p);
            Application.OpenURL(Connector.ConnectLink(new ClientInfo(appName, SystemInfo.deviceName), p, lb.RedirectUri));
            var code = await lb.WaitAsync(timeout, ct);
            var conn = await new Connector(baseUrl, Options).ExchangeCodeAsync(code, p.Verifier, ct);
            Credentials.Save(conn.ApiKey);
            Attach(conn.ApiKey);
        }

        /// <summary>Forgets the binding on this device. The player can also disconnect the game in GenDragoon.</summary>
        public void Disconnect()
        {
            keys?.Lock();
            Credentials.Clear();
            client = null; keys = null; drive = null;
        }

        Client NeedClient() => client ?? throw new InvalidOperationException("GenDragoon: not connected");

        /// <summary>Opens the encrypted saves with the player's recovery passphrase, creating the key on first use.</summary>
        public async Task UnlockAsync(string passphrase, CancellationToken ct = default)
        {
            var c = NeedClient();
            try { await keys!.UnlockAsync(passphrase, ct); }
            catch (ApiException e) when (e.NotFound) { await keys!.CreateAsync(passphrase, ct); }
            drive = new Drive(c, driveName, keys);
        }

        /// <summary>Uses a master key provided by the host launcher instead of a passphrase.</summary>
        public void UnlockWithKey(byte[] masterKey)
        {
            NeedClient();
            keys!.ImportMasterKey(masterKey);
            drive = new Drive(client!, driveName, keys);
        }

        Drive NeedDrive() => drive ?? throw new InvalidOperationException("GenDragoon: call UnlockAsync first");
        string SlotPath(string slot) => Drive.CleanPath(string.IsNullOrEmpty(slotFolder) ? slot : slotFolder + "/" + slot);

        public Task SaveAsync(string slot, byte[] data, CancellationToken ct = default) => NeedDrive().WriteFileAsync(SlotPath(slot), data, null, ct);

        public Task SaveJsonAsync<T>(string slot, T value, CancellationToken ct = default) =>
            SaveAsync(slot, System.Text.Encoding.UTF8.GetBytes(JsonUtility.ToJson(value)), ct);

        /// <summary>The slot's bytes, or null when the slot does not exist.</summary>
        public async Task<byte[]?> LoadAsync(string slot, CancellationToken ct = default)
        {
            try { return await NeedDrive().ReadFileAsync(SlotPath(slot), ct); }
            catch (ApiException e) when (e.NotFound) { return null; }
        }

        public async Task<T?> LoadJsonAsync<T>(string slot, CancellationToken ct = default) where T : class
        {
            var b = await LoadAsync(slot, ct);
            return b == null ? null : JsonUtility.FromJson<T>(System.Text.Encoding.UTF8.GetString(b));
        }

        public async Task<IReadOnlyList<Entry>> ListSlotsAsync(CancellationToken ct = default)
        {
            try { return (await NeedDrive().ListAsync(slotFolder, ct)).Where(e => !e.Folder).ToList(); }
            catch (ApiException e) when (e.NotFound) { return Array.Empty<Entry>(); }
        }

        /// <summary>Deletes one slot. Level L2, risk destructive.</summary>
        public Task DeleteSlotAsync(string slot, CancellationToken ct = default) => NeedDrive().DeleteAsync(SlotPath(slot), ct);

        /// <summary>Bytes used and the workspace quota.</summary>
        public Task<Usage> UsageAsync(CancellationToken ct = default) => NeedClient().UsageAsync(ct);

        void OnDestroy() => keys?.Lock();
    }
}

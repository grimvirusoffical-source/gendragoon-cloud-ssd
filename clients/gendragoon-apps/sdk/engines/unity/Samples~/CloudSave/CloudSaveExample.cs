#nullable enable
using System;
using Gendragoon.Unity;
using UnityEngine;

/// <summary>Saves and loads one slot. Attach next to a GendragoonCloudSave component.</summary>
public sealed class CloudSaveExample : MonoBehaviour
{
    [Serializable]
    public sealed class Progress { public int level; public float playSeconds; }

    [SerializeField] string connectCode = "";
    [SerializeField] string recoveryPassphrase = "";

    async void Start()
    {
        var save = GetComponent<GendragoonCloudSave>();
        try
        {
            if (!save.Connected) await save.ConnectAsync(connectCode);
            await save.UnlockAsync(recoveryPassphrase);
            var p = await save.LoadJsonAsync<Progress>("slot1.json") ?? new Progress();
            p.level++;
            await save.SaveJsonAsync("slot1.json", p);
            Debug.Log($"Saved level {p.level}");
        }
        catch (Exception e)
        {
            Debug.LogError(e.Message);
        }
    }
}

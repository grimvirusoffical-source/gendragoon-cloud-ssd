# Changelog

## 0.1.1

- Creating the first master key is L2, so `UnlockAsync` works on a fresh player at the default level.
  Replacing the key stays L3.
- `DeleteSlotAsync` uses the slot-scoped `files.deleteSlot` (L2): it deletes one file directly inside
  `slotFolder` and refuses folders and nested paths. General file deletion is L3.
- Folder pull in the bundled SDK refuses targets through symbolic links.

## 0.1.0

- `GendragoonCloudSave` component: connect with a connect code or a browser link, unlock with a recovery
  passphrase or a host-supplied key, and save, load, list and delete encrypted slots.
- `ICredentialStore` with a file-backed default.
- Cloud save sample.

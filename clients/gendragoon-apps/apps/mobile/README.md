# GenDragoon for iOS and Android

One Expo app. Screens call `@gendragoon/core` for the API client, lock state, sort map, merge planner, sealing, and account deletion.

Account deletion is `deleteAccountAndWipe`. The app does not send its own confirm body, poll path, 410 handling, or `auth_time` check. Workspace keys and bring-your-own credentials use core's `SecretStore`, implemented here with `expo-secure-store` and passed into core.

HTTP errors from the account API use `{ "error": "<machine_code>" }`. Jest fixtures use that shape (`reauth_required`, `invalid_token`, `account_deleted`, `not_found`, `workspace_lock`).

`EXPO_PUBLIC_API_BASE` is empty until the service URL exists. The app then stays in a local preview and does not claim a cloud delete. Google sign-in is enabled only when `EXPO_PUBLIC_GOOGLE_*_CLIENT_ID` is set.

Android prebuild (no native compile, no secrets):

```sh
pnpm --filter @gendragoon/mobile exec expo prebuild --no-install --platform android
```

iOS prebuild needs macOS. A store build needs Apple and Google credentials outside this repo. `expo-updates` reloads automatically when the build enables it. There is no in-app update button.

## Scripts

```sh
pnpm --filter @gendragoon/mobile typecheck
pnpm --filter @gendragoon/mobile test
```

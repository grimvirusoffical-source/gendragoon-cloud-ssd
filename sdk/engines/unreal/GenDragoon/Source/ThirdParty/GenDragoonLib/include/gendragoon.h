/*
 * GenDragoon C ABI (libgendragoon), built from sdk/go/cabi:
 *
 *   go build -buildmode=c-shared -o libgendragoon.so ./cabi
 *
 * Conventions
 *   - Every function returns a GD_* status. On failure *err (when err is not NULL) receives a UTF-8 message.
 *   - Strings and buffers returned through out parameters are owned by the caller; free them with gd_free.
 *   - Clients, keyrings, drives and Teams clients are opaque handles; release each with gd_release. Releasing a
 *     keyring wipes the master key from memory.
 *   - Calls block until the server answers (at most five minutes). Call them from a worker thread.
 *   - max_level caps the Rotten Apple level of the operations a handle may use (0-4; negative means the default,
 *     L3). GENDRAGOON_SDK_MAX_LEVEL in the environment can only lower it. A refused call returns GD_ERR_LEVEL
 *     without touching the network.
 */
#ifndef GENDRAGOON_H
#define GENDRAGOON_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
    GD_OK = 0,
    GD_ERR_LEVEL = 1,            /* the operation's level is above the handle's cap */
    GD_ERR_NOT_FOUND = 2,
    GD_ERR_PRECONDITION = 3,     /* a concurrent change won, or the master key already exists */
    GD_ERR_QUOTA = 4,
    GD_ERR_UNAUTHORIZED = 5,     /* API key or ID token revoked, expired or invalid */
    GD_ERR_WRONG_PASSPHRASE = 6,
    GD_ERR_INVALID = 7,          /* bad argument or handle */
    GD_ERR_RATE_LIMITED = 8,
    GD_ERR_OTHER = 9             /* network or server error; see *err */
};

typedef uint64_t gd_handle;

/* Library version, a static string; do not free. */
char *gd_version(void);
void gd_free(void *p);
void gd_release(gd_handle h);

/* Connect: redeems a one-time connect code. *connection_json is
 * {"bindingId","apiKey","keyExpiresAt","scopes","workspaceId","quotaBytes","capabilities"}. Store apiKey securely. */
int gd_connect_grant(const char *base, const char *grant, const char *app_name, int max_level, char **connection_json, char **err);

/* Provider client for one binding. base is the /provider/v1 URL. */
int gd_client_new(const char *base, const char *api_key, int max_level, gd_handle *client, char **err);
/* {"usedBytes","quotaBytes","objectCount","workspaceId","changeSeq","lastChangeAt"} */
int gd_usage(gd_handle client, char **usage_json, char **err);

/* Master key. unlock opens the binding's key envelope; create makes a new key (GD_ERR_PRECONDITION if one exists). */
int gd_keyring_unlock(gd_handle client, const char *passphrase, gd_handle *keyring, char **err);
int gd_keyring_create(gd_handle client, const char *passphrase, gd_handle *keyring, char **err);

/* Drives. keyring 0 opens an unencrypted drive. Paths are slash-separated ("saves/slot1.sav"). */
int gd_drive_open(gd_handle client, const char *name, gd_handle keyring, gd_handle *drive, char **err);
/* [{"name","path","folder","size","mtimeMs"}], folders first. folder "" or NULL is the root. */
int gd_drive_list(gd_handle drive, const char *folder, char **entries_json, char **err);
int gd_drive_read(gd_handle drive, const char *path, uint8_t **data, size_t *length, char **err);
int gd_drive_write(gd_handle drive, const char *path, const uint8_t *data, size_t length, char **err);
/* Deletes one file or empty folder. Level L3. */
int gd_drive_delete(gd_handle drive, const char *path, char **err);
/* Deletes the save slot folder/slot (slot is one path segment, never a folder). Level L2. */
int gd_drive_delete_slot(gd_handle drive, const char *folder, const char *slot, char **err);
int gd_drive_mkdir(gd_handle drive, const char *path, char **err);
int gd_drive_move(gd_handle drive, const char *from, const char *to, char **err);

/* Teams for a signed-in player (origin is the API origin; id_token a Firebase ID token). */
int gd_teams_new(const char *origin, const char *id_token, int max_level, gd_handle *teams, char **err);
int gd_teams_set_token(gd_handle teams, const char *id_token, char **err);
int gd_teams_list(gd_handle teams, char **teams_json, char **err);
int gd_teams_workspaces(gd_handle teams, const char *team_id, char **workspaces_json, char **err);
/* {"messages":[...],"latestSeq","pollAfterMs"}: messages above after. Poll again after pollAfterMs. */
int gd_teams_messages(gd_handle teams, const char *team_id, int64_t after, char **page_json, char **err);
int gd_teams_post(gd_handle teams, const char *team_id, const char *text, char **message_json, char **err);

#ifdef __cplusplus
}
#endif
#endif

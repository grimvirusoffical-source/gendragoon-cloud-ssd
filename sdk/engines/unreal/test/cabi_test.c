/*
 * Tests for the GenDragoon C ABI. Without arguments it runs the offline checks. With --interop [--init] it is the
 * "unreal" participant of sdk/contract/run.sh (GD_SDK_BASE, GD_SDK_KEY, GD_SDK_PASSPHRASE, GD_SDK_LANG). With
 * --first-run it replays the Unreal plugin's first session at its default level, L2 (contract C15), on a fresh
 * binding redeemed from GD_FIRST_RUN_GRANT.
 *
 *   cc -I../GenDragoon/Source/ThirdParty/GenDragoonLib/include cabi_test.c -L. -lgendragoon -o cabi_test
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "gendragoon.h"

static int failures = 0;
#define CHECK(cond, what) do { if (!(cond)) { fprintf(stderr, "FAIL %s\n", what); failures++; } else printf("PASS %s\n", what); } while (0)

static const char *KEY = "gdpk_0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

static int offline(void) {
    char *err = NULL;
    gd_handle c = 0, t = 0;
    CHECK(strcmp(gd_version(), "0.1.0") == 0, "version");
    CHECK(gd_client_new("http://127.0.0.1:9/provider/v1", "not-a-key", -1, &c, &err) != GD_OK && err != NULL, "malformed key refused");
    gd_free(err); err = NULL;
    CHECK(gd_client_new("http://127.0.0.1:9/provider/v1", KEY, 1, &c, &err) == GD_OK && c != 0, "client created");
    gd_handle d = 0;
    CHECK(gd_drive_open(c, "saves", 0, &d, &err) == GD_OK, "plain drive opened");
    char *json = NULL;
    CHECK(gd_drive_list(d, "", &json, &err) == GD_ERR_LEVEL, "L1 cannot list files (L2)");
    gd_free(err); err = NULL;
    CHECK(gd_drive_list(0, "", &json, &err) == GD_ERR_INVALID, "invalid handle refused");
    gd_free(err); err = NULL;
    CHECK(gd_drive_list(123456789, "", &json, &err) == GD_ERR_INVALID, "unknown handle refused");
    gd_free(err); err = NULL;
    CHECK(gd_teams_new("http://127.0.0.1:9", "token", 1, &t, &err) == GD_OK, "teams client created");
    CHECK(gd_teams_post(t, "team", "hi", &json, &err) == GD_ERR_LEVEL, "L1 cannot post to team chat (L2)");
    gd_free(err); err = NULL;
    gd_release(d); gd_release(c); gd_release(t);
    return failures == 0 ? 0 : 1;
}

static int interop(int init) {
    const char *lang = getenv("GD_SDK_LANG") ? getenv("GD_SDK_LANG") : "unreal";
    char *err = NULL, *json = NULL;
    gd_handle c = 0, k = 0, d = 0;
    if (gd_client_new(getenv("GD_SDK_BASE"), getenv("GD_SDK_KEY"), -1, &c, &err) != GD_OK) goto fail;
    if ((init ? gd_keyring_create : gd_keyring_unlock)(c, getenv("GD_SDK_PASSPHRASE"), &k, &err) != GD_OK) goto fail;
    if (gd_drive_open(c, "interop", k, &d, &err) != GD_OK) goto fail;
    if (gd_drive_list(d, "", &json, &err) != GD_OK) goto fail;
    /* Minimal scan of the listing for "from-<who>.txt" files; names are plain ASCII here. */
    char verified[1024] = "";
    for (char *p = strstr(json, "\"name\":\"from-"); p; p = strstr(p + 1, "\"name\":\"from-")) {
        char who[64] = "", path[128], want[128];
        if (sscanf(p, "\"name\":\"from-%63[^.\"].txt\"", who) != 1) continue;
        snprintf(path, sizeof path, "from-%s.txt", who);
        uint8_t *data = NULL; size_t n = 0;
        if (gd_drive_read(d, path, &data, &n, &err) != GD_OK) goto fail;
        snprintf(want, sizeof want, "hello from %s\n", who);
        int match = n == strlen(want) && memcmp(data, want, n) == 0;
        gd_free(data);
        if (!match) { fprintf(stderr, "%s: unexpected content\n", path); return 1; }
        if (verified[0]) strncat(verified, ",", sizeof verified - strlen(verified) - 1);
        strncat(verified, "\"", sizeof verified - strlen(verified) - 1);
        strncat(verified, who, sizeof verified - strlen(verified) - 1);
        strncat(verified, "\"", sizeof verified - strlen(verified) - 1);
    }
    gd_free(json);
    char path[128], body[128];
    snprintf(path, sizeof path, "from-%s.txt", lang);
    snprintf(body, sizeof body, "hello from %s\n", lang);
    if (gd_drive_write(d, path, (const uint8_t *)body, strlen(body), &err) != GD_OK) goto fail;
    printf("{\"lang\":\"%s\",\"verified\":[%s]}\n", lang, verified);
    gd_release(d); gd_release(k); gd_release(c);
    return 0;
fail:
    fprintf(stderr, "interop: %s\n", err ? err : "failed");
    gd_free(err);
    return 1;
}

static int first_run(void) {
    const char *base = getenv("GD_SDK_BASE"), *grant = getenv("GD_FIRST_RUN_GRANT");
    char *err = NULL, *conn = NULL, key[128] = "";
    gd_handle c = 0, k = 0, d = 0;
    if (!base || !grant) { fprintf(stderr, "set GD_SDK_BASE and GD_FIRST_RUN_GRANT\n"); return 1; }
    CHECK(gd_connect_grant(base, grant, "Unreal first run", 2, &conn, &err) == GD_OK, "C15 connect at L2");
    const char *p = conn ? strstr(conn, "\"apiKey\":\"") : NULL;
    if (p) { p += 10; size_t n = strcspn(p, "\""); if (n < sizeof key) memcpy(key, p, n); }
    gd_free(conn); gd_free(err); err = NULL;
    CHECK(gd_client_new(base, key, 2, &c, &err) == GD_OK, "C15 client at L2");
    CHECK(gd_keyring_unlock(c, "first run passphrase", &k, &err) == GD_ERR_NOT_FOUND, "C15 no key before the first save");
    gd_free(err); err = NULL;
    CHECK(gd_keyring_create(c, "first run passphrase", &k, &err) == GD_OK, "C15 first master key at L2");
    gd_free(err); err = NULL;
    gd_handle k2 = 0;
    CHECK(gd_keyring_create(c, "another passphrase", &k2, &err) == GD_ERR_PRECONDITION, "C15 second create cannot replace the key");
    gd_free(err); err = NULL;
    CHECK(gd_drive_open(c, "cloud-save", k, &d, &err) == GD_OK, "C15 open save drive");
    const char *v1 = "slot v1", *v2 = "slot v2, overwritten";
    CHECK(gd_drive_write(d, "saves/slot1", (const uint8_t *)v1, strlen(v1), &err) == GD_OK, "C15 save at L2");
    CHECK(gd_drive_write(d, "saves/slot1", (const uint8_t *)v2, strlen(v2), &err) == GD_OK, "C15 overwrite at L2");
    uint8_t *data = NULL; size_t n = 0;
    CHECK(gd_drive_read(d, "saves/slot1", &data, &n, &err) == GD_OK && n == strlen(v2) && memcmp(data, v2, n) == 0, "C15 load");
    gd_free(data); gd_free(err); err = NULL;
    CHECK(gd_drive_delete(d, "saves/slot1", &err) == GD_ERR_LEVEL, "C15 general delete refused at L2 (L3)");
    gd_free(err); err = NULL;
    int rc = gd_drive_delete_slot(d, "saves", "../slot1", &err);
    CHECK(rc != GD_OK && rc != GD_ERR_LEVEL, "C15 slot delete refuses a path");
    gd_free(err); err = NULL;
    CHECK(gd_drive_delete_slot(d, "saves", "slot1", &err) == GD_OK, "C15 slot delete at L2");
    gd_free(err); err = NULL;
    CHECK(gd_drive_read(d, "saves/slot1", &data, &n, &err) == GD_ERR_NOT_FOUND, "C15 deleted slot is gone");
    gd_free(err);
    gd_release(d); gd_release(k); gd_release(k2); gd_release(c);
    return failures == 0 ? 0 : 1;
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "--first-run") == 0) {
        int r = first_run();
        printf(r == 0 ? "first-run checks passed\n" : "first-run checks failed\n");
        return r;
    }
    if (argc > 1 && strcmp(argv[1], "--interop") == 0) return interop(argc > 2 && strcmp(argv[2], "--init") == 0);
    int r = offline();
    printf(r == 0 ? "offline checks passed\n" : "offline checks failed\n");
    return r;
}

/*
 * Tests for the GenDragoon C ABI. Without arguments it runs the offline checks. With --interop [--init] it is the
 * "unreal" participant of sdk/contract/run.sh (GD_SDK_BASE, GD_SDK_KEY, GD_SDK_PASSPHRASE, GD_SDK_LANG).
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

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "--interop") == 0) return interop(argc > 2 && strcmp(argv[2], "--init") == 0);
    int r = offline();
    printf(r == 0 ? "offline checks passed\n" : "offline checks failed\n");
    return r;
}

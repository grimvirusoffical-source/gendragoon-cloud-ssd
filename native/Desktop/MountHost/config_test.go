package main

import (
	"strings"
	"testing"
)

func configurationFixture() map[string]string {
	sid := "S-1-5-21-1-2-3-1001"
	return map[string]string{"GD_MOUNT_DAV_URL": "http://127.0.0.1:17779/", "GD_MOUNT_DAV_TOKEN": strings.Repeat("a", 43),
		"GD_MOUNT_CONTROL_TOKEN": strings.Repeat("b", 43), "GD_MOUNT_FILE_SECURITY": "O:" + sid + "G:" + sid + "D:P(A;;FRFX;;;" + sid + ")"}
}

func TestConfigurationIsStrictAndCredentialsAreEnvironmentOnly(t *testing.T) {
	env := configurationFixture()
	get := func(k string) string { return env[k] }
	c, err := parseConfiguration([]string{"--mount-point", "z:", "--volume-label", "Fixture 1"}, get)
	if err != nil || c.MountPoint != "Z:" {
		t.Fatal("valid fixture rejected")
	}
	for _, value := range []string{"http://localhost:1/", "http://127.0.0.2:1/", "http://127.0.0.1:0/", "https://127.0.0.1:1/", "http://a:b@127.0.0.1:1/", "http://127.0.0.1:1/?token=a", "http://127.0.0.1:1/#x", "http://127.0.0.1:1/a", "http://127.0.0.1:01/"} {
		env["GD_MOUNT_DAV_URL"] = value
		if _, err := parseConfiguration([]string{"--mount-point", "Z:", "--volume-label", "Fixture"}, get); err == nil {
			t.Fatal("unsafe origin accepted")
		}
	}
	for _, args := range [][]string{{"--mount-point", `C:\folder`, "--volume-label", "Fixture"}, {"--mount-point", "Z:", "--volume-label", "x,ro=false"}, {"--mount-point", "Z:", "--volume-label", "Fixture", "--token", "secret"}} {
		env = configurationFixture()
		if _, err := parseConfiguration(args, get); err == nil {
			t.Fatal("unsafe arguments accepted")
		}
	}
	env = configurationFixture()
	if _, err := parseConfiguration([]string{"--mount-point", "Z:", "--volume-label", strings.Repeat("x", 33)}, get); err == nil {
		t.Fatal("truncated volume identity accepted")
	}
}

func TestSecurityDescriptorIsExactCurrentUserOnly(t *testing.T) {
	for _, sid := range []string{"S-1-5-21-1-2-3-1001", "S-1-12-1-123-456-789-234"} {
		value := "O:" + sid + "G:" + sid + "D:P(A;;FRFX;;;" + sid + ")"
		if !validPrivateSDDL(sid, value) {
			t.Fatal("valid private descriptor refused")
		}
		for _, bad := range []string{value + "(A;;FRFX;;;WD)", strings.ReplaceAll(value, "FRFX", "FA"), strings.ReplaceAll(value, "D:P", "D:"), strings.ReplaceAll(value, sid, "S-1-5-21-9-9-9-9")} {
			if validPrivateSDDL(sid, bad) {
				t.Fatal("broader/different descriptor accepted")
			}
		}
	}
	for _, sid := range []string{"S-1-5-18", "S-1-1-0", "S-1-5-21-01-2-3-4", "S-1-5-21-4294967296-2-3-4"} {
		if validPrivateSDDL(sid, "O:"+sid+"G:"+sid+"D:P(A;;FRFX;;;"+sid+")") {
			t.Fatal("nonuser/noncanonical SID accepted")
		}
	}
}

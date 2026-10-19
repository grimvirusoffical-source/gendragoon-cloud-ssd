// Command gd-interop is the Go participant of the cross-language interop check (sdk/contract/run.sh).
// It opens the shared encrypted drive "interop", verifies every file written by the other SDKs, and
// writes its own. Configuration comes from GD_SDK_BASE, GD_SDK_KEY, GD_SDK_PASSPHRASE and GD_SDK_LANG.
// With -init it creates the binding's master key first.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	gd "github.com/grimvirusoffical-source/gendragoon-apps/sdk/go"
)

func main() {
	initKey := flag.Bool("init", false, "create the master key")
	flag.Parse()
	if err := run(*initKey); err != nil {
		fmt.Fprintln(os.Stderr, "gd-interop:", err)
		os.Exit(1)
	}
}

func run(initKey bool) error {
	ctx := context.Background()
	lang := os.Getenv("GD_SDK_LANG")
	if lang == "" {
		lang = "go"
	}
	c, err := gd.NewClient(os.Getenv("GD_SDK_BASE"), os.Getenv("GD_SDK_KEY"), nil)
	if err != nil {
		return err
	}
	keys := c.NewKeyring()
	pass := os.Getenv("GD_SDK_PASSPHRASE")
	if initKey {
		err = c.CreateMasterKey(ctx, keys, pass)
	} else {
		err = c.Unlock(ctx, keys, pass)
	}
	if err != nil {
		return err
	}
	d, err := c.OpenDrive("interop", keys, nil)
	if err != nil {
		return err
	}
	list, err := d.List(ctx, "")
	if err != nil {
		return err
	}
	var verified []string
	for _, e := range list {
		if e.Folder || !strings.HasPrefix(e.Name, "from-") {
			continue
		}
		who := strings.TrimSuffix(strings.TrimPrefix(e.Name, "from-"), ".txt")
		data, err := d.ReadFile(ctx, e.Path)
		if err != nil {
			return fmt.Errorf("%s: %w", e.Path, err)
		}
		if string(data) != "hello from "+who+"\n" {
			return fmt.Errorf("%s: unexpected content %q", e.Path, data)
		}
		verified = append(verified, who)
	}
	if _, err := d.WriteFile(ctx, "from-"+lang+".txt", []byte("hello from "+lang+"\n"), nil); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"lang": lang, "verified": verified})
}

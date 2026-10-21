// Command gd-vectors writes the cross-language test vectors (sdk/spec/vectors/v1.json).
package main

import (
	"fmt"
	"os"

	gendragoon "github.com/grimvirusoffical-source/gendragoon-apps/sdk/go"
)

func main() {
	out, err := gendragoon.TestVectors()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	path := "../spec/vectors/v1.json"
	if len(os.Args) > 1 {
		path = os.Args[1]
	}
	if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

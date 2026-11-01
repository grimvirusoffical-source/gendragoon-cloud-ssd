package main

import (
	"errors"
	"flag"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const version = "GenDragoon Mount Host 1.0.0"

var (
	drivePattern = regexp.MustCompile(`^[A-Za-z]:$`)
	labelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$`)
	tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,256}$`)
	sidPattern   = regexp.MustCompile(`^S-1-(5-21|12-1)-([0-9]+)-([0-9]+)-([0-9]+)-([0-9]+)$`)
)

type configuration struct {
	MountPoint   string
	VolumeLabel  string
	DAVURL       string
	DAVToken     string
	ControlToken string
	FileSecurity string
}

func parseConfiguration(args []string, getenv func(string) string) (configuration, error) {
	var c configuration
	flags := flag.NewFlagSet("gendragoon-mounthost", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&c.MountPoint, "mount-point", "", "unused drive letter")
	flags.StringVar(&c.VolumeLabel, "volume-label", "", "display label")
	if flags.Parse(args) != nil || flags.NArg() != 0 || !drivePattern.MatchString(c.MountPoint) || !labelPattern.MatchString(c.VolumeLabel) {
		return c, errors.New("configuration_invalid")
	}
	c.MountPoint = strings.ToUpper(c.MountPoint)
	c.DAVURL, c.DAVToken, c.ControlToken = getenv("GD_MOUNT_DAV_URL"), getenv("GD_MOUNT_DAV_TOKEN"), getenv("GD_MOUNT_CONTROL_TOKEN")
	c.FileSecurity = getenv("GD_MOUNT_FILE_SECURITY")
	u, err := url.Parse(c.DAVURL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Path != "" && u.Path != "/") || u.RawPath != "" {
		return c, errors.New("configuration_invalid")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || u.Host != "127.0.0.1:"+strconv.Itoa(port) || !tokenPattern.MatchString(c.DAVToken) || !tokenPattern.MatchString(c.ControlToken) || c.DAVToken == c.ControlToken || len(c.FileSecurity) > 512 || c.FileSecurity == "" {
		return c, errors.New("configuration_invalid")
	}
	c.DAVURL = "http://" + u.Host + "/"
	return c, nil
}

func validPrivateSDDL(sid, sddl string) bool {
	parts := sidPattern.FindStringSubmatch(sid)
	if parts == nil {
		return false
	}
	for _, value := range parts[2:] {
		n, err := strconv.ParseUint(value, 10, 32)
		if err != nil || strconv.FormatUint(n, 10) != value {
			return false
		}
	}
	return sddl == "O:"+sid+"G:"+sid+"D:P(A;;FRFX;;;"+sid+")"
}

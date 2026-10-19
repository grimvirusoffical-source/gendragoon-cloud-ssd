package gendragoon

import (
	"context"
	"errors"
	"time"
)

// EventType names a change seen by Watch.
type EventType string

const (
	ManifestCreated EventType = "manifest.created"
	ManifestUpdated EventType = "manifest.updated"
	ManifestDeleted EventType = "manifest.deleted"
	UsageChanged    EventType = "usage.changed"
	BindingRevoked  EventType = "binding.revoked"
)

// Event is one change. Key and Generation are set for manifest events, Usage for usage events.
type Event struct {
	Type       EventType
	Key        string
	Generation string
	Usage      *Usage
}

// WatchOptions configure Watch.
type WatchOptions struct {
	// Interval between /usage polls. Default 5 s, minimum 1 s.
	Interval time.Duration
	// ResyncEvery forces a full manifest listing even when changeSeq did not move. Default 10 min.
	ResyncEvery time.Duration
	// Keys limits manifest events to these manifest keys (for example one drive's ManifestKey).
	Keys []string
}

// Watch polls the binding and sends events until ctx ends or the binding is revoked; the channel is
// closed then. The server has no webhook or stream (capabilities.events): Watch polls /usage for
// changeSeq and lists manifests only when it moved. The first poll records the current state and
// emits nothing. Level L2, risk read.
func (c *Client) Watch(ctx context.Context, opts WatchOptions) (<-chan Event, error) {
	if err := c.check("events.watch"); err != nil {
		return nil, err
	}
	if opts.Interval == 0 {
		opts.Interval = 5 * time.Second
	}
	opts.Interval = max(opts.Interval, time.Second)
	if opts.ResyncEvery == 0 {
		opts.ResyncEvery = 10 * time.Minute
	}
	filter := map[string]bool{}
	for _, k := range opts.Keys {
		filter[k] = true
	}
	ch := make(chan Event, 64)
	go func() {
		defer close(ch)
		var seen map[string]string
		var last *Usage
		lastList := time.Time{}
		emit := func(e Event) bool {
			select {
			case ch <- e:
				return true
			case <-ctx.Done():
				return false
			}
		}
		for first := true; ; first = false {
			u, err := c.Usage(ctx)
			if errors.Is(err, ErrUnauthorized) {
				emit(Event{Type: BindingRevoked})
				return
			}
			if err == nil {
				if !first && (u.UsedBytes != last.UsedBytes || u.ObjectCount != last.ObjectCount || u.QuotaBytes != last.QuotaBytes) {
					if !emit(Event{Type: UsageChanged, Usage: u}) {
						return
					}
				}
				if first || u.ChangeSeq != last.ChangeSeq || time.Since(lastList) >= opts.ResyncEvery {
					if items, err := c.AllManifests(ctx); err == nil {
						lastList = time.Now()
						now := map[string]string{}
						for _, it := range items {
							if len(filter) == 0 || filter[it.ID] {
								now[it.ID] = it.Generation
							}
						}
						if seen != nil {
							for _, k := range sortedKeys(now) {
								old, ok := seen[k]
								switch {
								case !ok:
									if !emit(Event{Type: ManifestCreated, Key: k, Generation: now[k]}) {
										return
									}
								case old != now[k]:
									if !emit(Event{Type: ManifestUpdated, Key: k, Generation: now[k]}) {
										return
									}
								}
							}
							for _, k := range sortedKeys(seen) {
								if _, ok := now[k]; !ok {
									if !emit(Event{Type: ManifestDeleted, Key: k}) {
										return
									}
								}
							}
						}
						seen = now
					}
				}
				last = u
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(opts.Interval):
			}
		}
	}()
	return ch, nil
}

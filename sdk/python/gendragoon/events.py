"""Change events by polling. The server has no webhook or stream (capabilities["events"]): watch() polls /usage for
changeSeq and lists manifests only when it moved (or every resync_every seconds)."""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Iterator, Optional

from .client import Client
from .errors import APIError


@dataclass
class Event:
    type: str  # manifest.created | manifest.updated | manifest.deleted | usage.changed | binding.revoked
    key: Optional[str] = None
    generation: Optional[str] = None
    usage: Optional[dict] = None


def watch(c: Client, *, interval: float = 5.0, resync_every: float = 600.0, keys: Optional[list[str]] = None,
          stop: Optional[threading.Event] = None) -> Iterator[Event]:
    """Yields changes until stop is set or the binding is revoked. The first poll records the current state and
    yields nothing. Level L2, risk read."""
    c.check("events.watch")
    interval = max(interval, 1.0)
    stop = stop or threading.Event()
    filt = set(keys or [])
    seen: Optional[dict] = None
    last: Optional[dict] = None
    last_list = 0.0
    while not stop.is_set():
        try:
            u = c.usage()
        except APIError as e:
            if e.unauthorized:
                yield Event("binding.revoked")
                return
            u = None
        except ConnectionError:
            u = None
        if u is not None:
            if last and any(u[k] != last[k] for k in ("usedBytes", "objectCount", "quotaBytes")):
                yield Event("usage.changed", usage=u)
            if last is None or u.get("changeSeq") != last.get("changeSeq") or time.monotonic() - last_list >= resync_every:
                try:
                    now = {it.id: it.generation for it in c.all_manifests() if not filt or it.id in filt}
                    last_list = time.monotonic()
                    if seen is not None:
                        for k in sorted(now):
                            if k not in seen:
                                yield Event("manifest.created", k, now[k])
                            elif seen[k] != now[k]:
                                yield Event("manifest.updated", k, now[k])
                        for k in sorted(set(seen) - set(now)):
                            yield Event("manifest.deleted", k)
                    seen = now
                except (APIError, ConnectionError):
                    pass
            last = u
        stop.wait(interval)

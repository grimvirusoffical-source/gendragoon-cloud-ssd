"""Rotten Apple levels (docs/SDK_LEVELS.md: L0 Applicant, L1 Starter, L2 Established, L3 Trusted, L4 By approval)
and the gate that checks every operation before it runs."""
from __future__ import annotations

import os
from typing import Callable, NamedTuple

LEVELS = ("L0", "L1", "L2", "L3", "L4")
DEFAULT_MAX_LEVEL = "L3"
#: A host (the Rotten Apple launcher) sets this to cap the level. It can only lower the cap.
MAX_LEVEL_ENV = "GENDRAGOON_SDK_MAX_LEVEL"


class Operation(NamedTuple):
    id: str
    level: str
    service: str  # Rotten Apple service id: "data.storage" or "gendragoon"
    risk: str
    context: str  # "app" (API key), "user" (signed-in account) or "local" (no network)
    method: str
    path: str
    scope: str
    summary: str


Gate = Callable[[Operation], None]


def parse_level(value: str) -> str:
    t = value.strip().upper().removeprefix("L")
    if len(t) == 1 and t in "01234":
        return "L" + t
    raise ValueError(f"gendragoon: unknown level {value!r}")


def _rank(level: str) -> int:
    return int(level[1])


class LevelError(PermissionError):
    """The gate refused an operation above the allowed level."""

    def __init__(self, op: Operation, allowed: str):
        super().__init__(f"gendragoon: {op.id} needs {op.level} ({op.risk}); this client allows up to {allowed}")
        self.op = op
        self.allowed = allowed


def level_gate(max_level: str = DEFAULT_MAX_LEVEL) -> Gate:
    """Allows operations at or below max_level, lowered further by GENDRAGOON_SDK_MAX_LEVEL.
    An unreadable value locks the client to L0."""
    eff = parse_level(max_level)
    env = os.environ.get(MAX_LEVEL_ENV)
    if env is not None:
        try:
            lvl = parse_level(env)
            if _rank(lvl) < _rank(eff):
                eff = lvl
        except ValueError:
            eff = "L0"

    def gate(op: Operation) -> None:
        if _rank(op.level) > _rank(eff):
            raise LevelError(op, eff)

    return gate

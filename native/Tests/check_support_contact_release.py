#!/usr/bin/env python3
"""Fail a release while the account-deletion support contact is still a placeholder.

grim has not picked the real email or URL. GDSupportContact.current.isPlaceholder
stays true until that value is real. This script exits 1 in that state.
"""
from pathlib import Path
import sys

SOURCE = Path(__file__).resolve().parents[1] / "Sources" / "GDSupportContact.swift"


def main() -> int:
    text = SOURCE.read_text(encoding="utf-8")
    if "isPlaceholder: true" in text:
        print(
            "release check failed: GDSupportContact.current is still a placeholder",
            file=sys.stderr,
        )
        return 1
    if "isPlaceholder: false" not in text:
        print(
            "release check failed: GDSupportContact.current has no isPlaceholder flag",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

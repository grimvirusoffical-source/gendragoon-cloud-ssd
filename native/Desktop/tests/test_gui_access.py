"""Workspace mount-first UI gating: no network, no mount side effects."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gui_access import mount_ready, visible_pages

OWNER = "a" * 64
OTHER = "c" * 64
FIRST = "b" * 32
SECOND = "d" * 32


class MountAccessTests(unittest.TestCase):
    def test_no_mount_shows_only_home_and_account(self):
        self.assertEqual(visible_pages(mount_ready([], OWNER, [{"id": FIRST}])), ("Home", "Account"))

    def test_owned_mount_unlocks_all_pages(self):
        mounted = [{"receiverId": OWNER, "workspaceId": FIRST, "state": "mounted"}]
        self.assertTrue(mount_ready(mounted, OWNER, [{"id": FIRST}]))
        self.assertEqual(len(visible_pages(True)), 5)

    def test_foreign_workspace_never_unlocks(self):
        mount = [{"receiverId": OTHER, "workspaceId": FIRST, "state": "mounted"}]
        self.assertFalse(mount_ready(mount, OWNER, [{"id": FIRST}]))
        mount[0]["receiverId"] = OWNER
        self.assertFalse(mount_ready(mount, OWNER, [{"id": SECOND}]))

    def test_stale_or_unverified_states_do_not_unlock(self):
        for state in ("orphaned", "preparing", "unmounted", "error", None):
            with self.subTest(state=state):
                self.assertFalse(mount_ready([{"receiverId": OWNER, "workspaceId": FIRST, "state": state}],
                                             OWNER, [{"id": FIRST}]))

    def test_missing_or_invalid_identity_does_not_unlock(self):
        mount = [{"receiverId": OWNER, "workspaceId": FIRST, "state": "mounted"}]
        for receiver in (None, "", "not-an-owner", OTHER):
            with self.subTest(receiver=receiver):
                self.assertFalse(mount_ready(mount, receiver, [{"id": FIRST}]))

    def test_multiple_workspaces_can_be_mounted(self):
        mounts = [{"receiverId": OWNER, "workspaceId": SECOND, "state": "mounted"},
                  {"receiverId": OWNER, "workspaceId": FIRST, "state": "mounted"}]
        self.assertTrue(mount_ready(mounts, OWNER, [{"id": FIRST}, {"id": SECOND}]))


if __name__ == "__main__":
    unittest.main()

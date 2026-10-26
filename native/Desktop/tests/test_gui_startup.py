"""Construct the actual target Tk GUI in an isolated profile, without signing in."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

DESKTOP=Path(__file__).resolve().parents[1]
RUNTIME=Path(os.environ.get("GD_DESKTOP_RUNTIME",DESKTOP))
sys.path.insert(0,str(RUNTIME))
if (RUNTIME/"runtime").is_dir():sys.path.insert(0,str(RUNTIME/"runtime"))

@unittest.skipUnless(sys.platform=="win32" or sys.platform.startswith("linux"),"Target Windows/Linux GUI runtime required")
class DesktopGUIStartupTests(unittest.TestCase):
    def test_real_files_teams_keys_widgets_and_clean_close_without_network(self):
        import tkinter as tk
        from gendragoon_gui import GenDragoonGUI
        with tempfile.TemporaryDirectory(prefix="gd-gui-fixture-") as td:
            root=Path(td).resolve()
            env={"XDG_DATA_HOME":str(root/"data"),"XDG_STATE_HOME":str(root/"state"),"LOCALAPPDATA":str(root/"local")}
            with patch.dict(os.environ,env),patch("redx_session.http_json",side_effect=AssertionError("Startup must not send account credentials or network requests")):
                window=tk.Tk();window.withdraw()
                app=GenDragoonGUI(window,companion_directory=root/"ipc")
                try:
                    window.update_idletasks();window.update()
                    self.assertEqual([app.tabs.tab(tab,"text") for tab in app.tabs.tabs()],["Files","Teams","Storage keys"])
                    self.assertFalse(app.busy);self.assertIsNone(app.model.keys);self.assertIsNone(app.model.session.receiver)
                    self.assertEqual(app.tree.get_children(),())
                    self.assertTrue(app.companion is not None)
                finally:app.close()

    def test_packaging_gui_probe_is_signed_out_and_restores_the_environment(self):
        from gendragoon_gui import check_gui
        before={key:os.environ.get(key) for key in ("XDG_DATA_HOME","XDG_STATE_HOME","LOCALAPPDATA")}
        with patch("redx_session.http_json",side_effect=AssertionError("The packaged GUI probe must not contact account services")):
            check_gui()
        self.assertEqual({key:os.environ.get(key) for key in before},before)

if __name__=="__main__":unittest.main()

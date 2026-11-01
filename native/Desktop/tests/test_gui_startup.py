"""Construct the actual target Tk GUI in an isolated profile, without signing in."""
import json
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
    def test_quitting_actual_gui_retains_portable_process_tree_and_uncertain_state_blocks_account_change(self):
        from gendragoon_gui import GenDragoonGUI
        from desktop_drop import create_root
        from test_machinenotes import compile_portable_fixture,prepare_native_fixture,wait_fixture
        import time
        with tempfile.TemporaryDirectory(prefix='gd-gui-portable-fixture-') as td:
            directory=Path(td).resolve();binary=compile_portable_fixture(directory)
            env={'XDG_DATA_HOME':str(directory/'data'),'XDG_STATE_HOME':str(directory/'state'),'LOCALAPPDATA':str(directory/'local')}
            with patch.dict(os.environ,env),patch('redx_session.http_json',side_effect=AssertionError('Portable GUI fixture cannot use network')):
                window=create_root();window.withdraw();app=GenDragoonGUI(window,companion_directory=directory/'ipc');closed=False;prepared=None
                try:
                    prepared=prepare_native_fixture(app.model.portable_apps,binary)
                    receipt=app.model.portable_apps.launch(prepared,binary.name,approved=True)
                    try:wait_fixture(lambda:(prepared.payload/'child-heartbeat').exists())
                    except AssertionError:
                        code=next((row.get('mainExitCode') for row in app.model.portable_apps.leases() if row.get('id')==receipt['id']),None)
                        child_error=None
                        try:
                            value=int((prepared.payload/'e').read_text(encoding='ascii'))
                            if 0<=value<=0xffffffff:child_error=value
                        except (OSError,ValueError):pass
                        details=dict(mainExitCode=code,cwdUtf16Units=len(str(prepared.payload).encode('utf-16-le'))//2,
                            exeUtf16Units=len(str(prepared.payload/binary.name).encode('utf-16-le'))//2,fixtureChildWinerror=child_error)
                        raise AssertionError('Disposable GUI native diagnostics: '+json.dumps(details,sort_keys=True)) from None
                    with patch('tkinter.messagebox.showwarning') as warning:
                        self.assertFalse(app.can_switch());self.assertTrue(warning.called)
                    app.close();closed=True
                    before=(prepared.payload/'child-heartbeat').read_text();time.sleep(.2)
                    self.assertNotEqual((prepared.payload/'child-heartbeat').read_text(),before)
                    self.assertEqual(app.model.portable_apps.leases()[0]['state'],'running')
                    self.assertTrue((prepared.payload/binary.name).exists())
                finally:
                    if prepared is not None:(prepared.payload/'release-child').write_text('release only the disposable GUI fixture')
                    if not closed:app.close()
                wait_fixture(lambda:app.model.portable_apps.leases()[0]['state']=='complete')
                self.assertTrue((prepared.payload/'child-finished').exists())

    def test_real_files_teams_keys_widgets_and_clean_close_without_network(self):
        import tkinter as tk
        from gendragoon_gui import GenDragoonGUI
        from desktop_drop import create_root,require_native_drop
        with tempfile.TemporaryDirectory(prefix="gd-gui-fixture-") as td:
            root=Path(td).resolve()
            env={"XDG_DATA_HOME":str(root/"data"),"XDG_STATE_HOME":str(root/"state"),"LOCALAPPDATA":str(root/"local")}
            with patch.dict(os.environ,env),patch("redx_session.http_json",side_effect=AssertionError("Startup must not send account credentials or network requests")):
                window=create_root();window.withdraw()
                app=GenDragoonGUI(window,companion_directory=root/"ipc")
                try:
                    window.update_idletasks();window.update()
                    self.assertEqual([app.tabs.tab(tab,"text") for tab in app.tabs.tabs()],["Home","Files","Teams","Storage keys","Account"])
                    self.assertEqual(app.tabs.select(),str(app.home))
                    for pane in (app.files,app.teams,app.settings):
                        self.assertEqual(app.tabs.tab(pane,"state"),"disabled")
                    self.assertEqual(app.tabs.tab(app.account,"state"),"normal")
                    self.assertEqual(require_native_drop(window)["native"],"2.10.3")
                    self.assertFalse(app.busy);self.assertIsNone(app.model.keys);self.assertIsNone(app.model.session.receiver)
                    self.assertEqual(app.tree.get_children(),())
                    self.assertTrue(app.companion is not None)
                finally:app.close()

    def test_real_mixed_picker_direct_queue_and_transfer_widgets_with_only_fixture_paths(self):
        import tkinter as tk
        from gendragoon_gui import GenDragoonGUI,MixedSourcePicker
        from desktop_drop import create_root,require_native_drop
        from desktop_transfer_ui import destination
        import time
        with tempfile.TemporaryDirectory(prefix="gd-picker-fixture-") as td:
            root=Path(td).resolve();sources=root/'sources';sources.mkdir();folder=sources/'Folder';folder.mkdir();file=sources/'File.txt';file.write_bytes(b'fixture');appfile=sources/'Portable.exe';appfile.write_bytes(b'backup fixture')
            env={"XDG_DATA_HOME":str(root/'data'),"XDG_STATE_HOME":str(root/'state'),"LOCALAPPDATA":str(root/'local')}
            with patch.dict(os.environ,env),patch('redx_session.http_json',side_effect=AssertionError('UI fixture must not use network')):
                window=create_root();window.withdraw();app=GenDragoonGUI(window,companion_directory=root/'ipc');picker=None
                try:
                    accepted=[];context=destination('a'*64,'b'*32,note_name='Frozen note')
                    picker=MixedSourcePicker(app,context,lambda target,paths:accepted.append((target,paths)),roots=[('Disposable files',sources)])
                    parent=picker.tree.get_children()[0];self.assertFalse(picker.nodes[parent].get('loaded'));picker.tree.focus(parent);picker.expand()
                    deadline=time.monotonic()+5
                    while not picker.nodes[parent].get('loaded') and time.monotonic()<deadline:window.update();time.sleep(.01)
                    self.assertTrue(picker.nodes[parent].get('loaded'));self.assertEqual(require_native_drop(picker.tree)['native'],'2.10.3');keys=[key for key in picker.tree.get_children(parent) if picker.nodes.get(key,{}).get('selectable')]
                    self.assertEqual(len(keys),3);picker.tree.selection_set(keys);picker.upload_button.invoke();self.assertTrue(picker.closed)
                    self.assertEqual(set(accepted[0][1]),{str(folder),str(file),str(appfile)});self.assertEqual(accepted[0][0],context)
                    reviewed=[];second=MixedSourcePicker(app,context,lambda target,paths:reviewed.append(paths),roots=[('Disposable files',sources)],initial_paths=[str(file),str(folder)])
                    try:
                        self.assertEqual(reviewed,[],'Staged drop/review paths must not upload automatically');self.assertEqual(len(second.tree.selection()),2);second.upload_button.invoke();self.assertEqual(set(reviewed[0]),{str(file),str(folder)})
                    finally:
                        if not second.closed:second.close()
                    self.assertIsNotNone(app.progress_bar);self.assertIsNotNone(app.jobs_tree);app.show_transfers();window.update();self.assertEqual(app.transfers_window.state(),'normal');app.hide_transfers();window.update();self.assertEqual(app.transfers_window.state(),'withdrawn')
                    catalog_folder={'key':'f'*18,'kind':'folder','virtualFolder':True,'name':'Folder'}
                    catalog_app={'key':'c'*18,'parentKey':'f'*18,'kind':'file','name':'Portable.exe','origin':{'schema':1,'platform':'linux','architecture':'x86_64','deviceId':'a'*32}}
                    catalog_doc={'key':'d'*18,'parentKey':'f'*18,'kind':'file','name':'Readme.txt'}
                    app.model.selected_note='b'*32;app.model.items=[catalog_folder,catalog_app,catalog_doc];app.display_tree();app.artifact_choice.set('Windows');app.display_tree(refresh_snapshot=False)
                    self.assertEqual(app.tree.get_children('f'*18),('c'*18,));self.assertIn('Windows app/installer backup',app.tree.item('c'*18,'values')[0]);self.assertIn('Linux',app.tree.item('c'*18,'values')[1])
                    self.assertEqual(file.read_bytes(),b'fixture');self.assertEqual(appfile.read_bytes(),b'backup fixture')
                finally:
                    if picker is not None and not picker.closed:picker.close()
                    app.close()

    def test_packaging_gui_probe_is_signed_out_and_restores_the_environment(self):
        from gendragoon_gui import check_gui
        before={key:os.environ.get(key) for key in ("XDG_DATA_HOME","XDG_STATE_HOME","LOCALAPPDATA")}
        with patch("redx_session.http_json",side_effect=AssertionError("The packaged GUI probe must not contact account services")):
            check_gui()
        self.assertEqual({key:os.environ.get(key) for key in before},before)

if __name__=="__main__":unittest.main()

"""Pure filesystem/presentation fixtures; never use account data or user sources."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch,MagicMock

DESKTOP=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(DESKTOP))
RUNTIME=Path(os.environ.get("GD_DESKTOP_RUNTIME",DESKTOP));sys.path.insert(0,str(RUNTIME))
import desktop_transfer_ui as ui

class SelectionTests(unittest.TestCase):
    def test_mixed_file_folder_application_backups_and_exact_destination(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();folder=root/'App files';folder.mkdir();file=root/'café 😀.txt';file.write_bytes(b'file');app=root/'Portable.exe';app.write_bytes(b'explicit backup only')
            selected=ui.validate_sources([str(file),str(folder),str(app),str(file)])
            self.assertEqual(selected,[str(file),str(folder),str(app)])
            context=ui.destination('a'*64,'b'*32,'c'*18,note_name='Note',folder_name='Folder')
            self.assertEqual(context['workspaceId'],'b'*32);self.assertEqual(context['parentKey'],'c'*18)
            self.assertEqual(file.read_bytes(),b'file');self.assertEqual(app.read_bytes(),b'explicit backup only')
    def test_overlap_links_relative_missing_and_foreign_app_selections_fail_clearly(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();folder=root/'folder';folder.mkdir();child=folder/'file';child.write_bytes(b'fixture')
            with self.assertRaisesRegex(ValueError,'folder or its contents'):ui.validate_sources([str(folder),str(child)])
            for paths in ([],['relative'],[str(root/'missing')],[str(root)]*101):
                with self.subTest(paths=paths),self.assertRaises((ValueError,OSError)):ui.validate_sources(paths)
            app=root/'Mac.app';app.mkdir()
            with self.assertRaisesRegex(ValueError,'macOS'):ui.validate_sources([str(app)])
            if os.name!='nt':
                link=root/'link';link.symlink_to(folder,target_is_directory=True)
                with self.assertRaisesRegex(ValueError,'Linked'):ui.validate_sources([str(link/'file')])
                with self.assertRaisesRegex(ValueError,'Linked'):ui.directory_page(link)
    def test_lazy_directory_pages_are_bounded_and_do_not_recurse(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();folder=root/'directory';folder.mkdir();(folder/'nested').write_bytes(b'not browsed')
            for i in range(6):(root/f'{i}.txt').write_bytes(b'text')
            found=[];offset=0
            while offset is not None:
                page=ui.directory_page(root,offset,limit=2);self.assertLessEqual(len(page['entries']),2);found.extend(page['entries']);offset=page['nextOffset']
            self.assertEqual({p['name'] for p in found},{'directory',*[f'{i}.txt' for i in range(6)]});self.assertEqual(len(found),7)
            self.assertNotIn('nested',{p['name'] for p in found})
            for args in ((-1,2),(0,251),(0,0)):
                with self.assertRaises(ValueError):ui.directory_page(root,*args)
    def test_directory_page_bounds_inaccessible_entries_too(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();entry=MagicMock();entry.stat.side_effect=PermissionError('fixture inaccessible')
            iterator=MagicMock();iterator.__enter__.return_value=iter([entry]*100)
            with patch.object(ui.os,'scandir',return_value=iterator):page=ui.directory_page(root,0,limit=2)
            self.assertEqual(entry.stat.call_count,2);self.assertEqual(page,{'entries':[],'nextOffset':2})
    def test_staging_includes_new_first_party_module(self):
        import stage_runtime
        self.assertIn('desktop_transfer_ui.py',stage_runtime.CLIENTS)

class FrozenQueueTests(unittest.TestCase):
    def test_displayed_destination_survives_transient_worker_note_and_queues_while_busy(self):
        import gendragoon_gui as gui
        app=gui.GenDragoonGUI.__new__(gui.GenDragoonGUI);app.busy=True
        app.note=SimpleNamespace(current=lambda:0);app.selected=lambda:['c'*18]
        app.visible_items={'c'*18:{'key':'c'*18,'virtualFolder':True,'displayName':'Chosen folder'}}
        calls=[];app.model=SimpleNamespace(session=SimpleNamespace(receiver='a'*64),keys={},vault_exported=True,notes=[{'id':'b'*32,'name':'Visible note','active':True}],selected_note='d'*32,enqueue_selection=lambda *args:calls.append(args) or {'id':'e'*32})
        app.status=MagicMock();app.refresh_jobs=lambda:None;app.show_transfers=lambda:None;app.drain_queue=lambda:None
        context=app.upload_context();self.assertEqual(context['workspaceId'],'b'*32);self.assertEqual(context['parentKey'],'c'*18)
        with tempfile.TemporaryDirectory() as td:
            source=Path(td).resolve()/'file';source.write_bytes(b'selected fixture')
            app.queue_sources(context,[str(source)]);self.assertEqual(calls,[('b'*32,'c'*18,[str(source)])])
            app.model.session.receiver='f'*64
            with self.assertRaisesRegex(ValueError,'account changed'):app.queue_sources(context,[str(source)])
            self.assertEqual(len(calls),1)
    def test_read_only_destination_is_not_mistaken_for_upload_authority(self):
        import gendragoon_gui as gui
        app=gui.GenDragoonGUI.__new__(gui.GenDragoonGUI);app.note=SimpleNamespace(current=lambda:0)
        app.model=SimpleNamespace(notes=[{'id':'b'*32,'active':False}],session=SimpleNamespace(receiver='a'*64))
        with self.assertRaisesRegex(ValueError,'read only'):app.upload_context()

class PlatformPresentationTests(unittest.TestCase):
    def test_artifact_and_source_filters_preserve_virtual_ancestors(self):
        origin={'schema':1,'platform':'linux','architecture':'x86_64','deviceId':'a'*32}
        folder={'key':'f'*18,'kind':'folder','virtualFolder':True,'name':'Folder'}
        app={'key':'b'*18,'parentKey':folder['key'],'kind':'file','name':'Portable.exe','applicationPlatform':'windows','origin':origin}
        document={'key':'c'*18,'parentKey':folder['key'],'kind':'file','name':'Readme.txt','applicationPlatform':None}
        items=[folder,app,document]
        self.assertEqual([i['key'] for i in ui.filter_library(items,artifact='windows')],[folder['key'],app['key']])
        self.assertEqual([i['key'] for i in ui.filter_library(items,source='linux:'+'a'*32)],[folder['key'],app['key']])
        self.assertEqual([i['key'] for i in ui.filter_library(items,artifact='documents')],[folder['key'],document['key']])
        self.assertIn('Linux',ui.source_label(app));self.assertEqual(ui.source_label(document),'Unknown source device')
        self.assertEqual(app['applicationPlatform'],'windows','Source OS must not replace the artifact OS hint')
    def test_foreign_artifact_in_virtual_folder_is_refused_before_staging_or_payload_read(self):
        import machinenotes_client as client
        folder={'key':'f'*18,'kind':'folder','virtualFolder':True,'name':'Folder'}
        app={'key':'b'*18,'parentKey':folder['key'],'kind':'file','name':'Portable.exe','applicationPlatform':'windows'}
        document={'key':'c'*18,'parentKey':folder['key'],'kind':'file','name':'Readme.txt'}
        model=client.MachineNotesClient.__new__(client.MachineNotesClient);model.items=[folder,app,document];model.config=lambda:{};model.refresh_tree=lambda:{'items':model.items}
        with tempfile.TemporaryDirectory() as td,patch('gendragoon_device_origin.current_platform',return_value='linux'),patch.object(client.private,'private_directory',side_effect=AssertionError('No staging before compatibility')) as staging,patch.object(client.storage,'download_archive',side_effect=AssertionError('No foreign payload read')) as payload:
            path=Path(td).resolve();marker=path/'original';marker.write_bytes(b'preserved')
            with self.assertRaisesRegex(ValueError,'platform'):model.download(folder['key'],path)
            staging.assert_not_called();payload.assert_not_called();self.assertEqual(marker.read_bytes(),b'preserved')
            model.check_restore_compatible([document['key']],items=model.items)

class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.now=0;self.view=ui.TransferPresentation(lambda:self.now);self.job={'id':'a'*32,'sources':['one','two'],'state':'running','completedSources':[]}
    def progress(self,**values):
        return self.view.snapshot(self.job,dict(phase='uploading',completed_bytes=0,total_bytes=100,**values))
    def test_percent_never_finishes_before_verified_success_or_regresses_between_sources(self):
        a=self.view.snapshot(self.job,{'phase':'uploading','completed_bytes':70,'total_bytes':100})
        b=self.view.snapshot(self.job,{'phase':'encoding','completed_bytes':20,'total_bytes':100})
        self.assertGreaterEqual(b['percent'],a['percent'])
        c=self.view.snapshot(self.job,{'phase':'complete'});self.assertLess(c['percent'],100)
        self.job['completedSources']=[0];d=self.view.snapshot(self.job,{'phase':'archiving','total_bytes':100});self.assertGreaterEqual(d['percent'],c['percent'])
        self.job['completedSources']=[0,1];e=self.view.snapshot(self.job,{'phase':'complete'});self.assertLess(e['percent'],100)
        self.job['state']='completed';self.assertEqual(self.view.snapshot(self.job,{'phase':'complete'})['percent'],100)
    def test_eta_uses_observed_progress_and_stays_unknown_when_work_is_stalled(self):
        first=self.view.snapshot(self.job,{'phase':'uploading','completed_bytes':10,'total_bytes':100});self.assertIsNone(first['phaseETA']);self.assertIsNone(first['overallETA'])
        self.now=5;second=self.view.snapshot(self.job,{'phase':'uploading','completed_bytes':50,'total_bytes':100,'uploaded_bytes':123456,'downloaded_bytes':777})
        self.assertAlmostEqual(second['phaseETA'],6.25);self.assertGreater(second['overallETA'],0);self.assertEqual(second['uploadedBytes'],123456);self.assertEqual(second['downloadedBytes'],777)
        idle=ui.TransferPresentation(lambda:self.now);idle.snapshot(self.job,{'phase':'archiving','completed_bytes':0,'total_bytes':100});self.now=15
        stopped=idle.snapshot(self.job,{'phase':'archiving','completed_bytes':0,'total_bytes':100});self.assertIsNone(stopped['phaseETA']);self.assertIsNone(stopped['overallETA'])
    def test_failure_does_not_claim_completion_and_invalid_counters_are_not_displayed(self):
        self.view.snapshot(self.job,{'phase':'readback','completed_bytes':50,'total_bytes':100})
        result=self.view.snapshot(self.job,{'phase':'unknown','completed_bytes':float('nan'),'uploaded_bytes':-1,'total_bytes':True},finished=False)
        self.assertLess(result['percent'],100);self.assertTrue(result['terminal']);self.assertEqual(result['completedBytes'],0);self.assertEqual(result['uploadedBytes'],0);self.assertEqual(result['totalBytes'],0);self.assertIsNone(result['overallETA'])
    def test_formatting_counters_and_estimates_never_claim_time_saved(self):
        self.assertEqual(ui.format_eta(None),'measuring');self.assertEqual(ui.format_eta(61),'1m 01s');self.assertEqual(ui.format_bytes(1024),'1.0 KiB')
        self.assertNotIn('saved',json.dumps(self.view.snapshot(self.job,{})))

if __name__=='__main__':unittest.main()

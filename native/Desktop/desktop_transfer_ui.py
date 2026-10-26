"""Account-free selection and honest transfer presentation for the desktop GUI.

This module never uploads, deletes, launches, changes accounts, or reads keys.
Filesystem browsing is lazy and bounded; final source validation remains in the
current MachineNotes encrypted transfer model.
"""
import math
import os
from pathlib import Path
import re
import stat
import time

MAX_SOURCES=100
PAGE_SIZE=250
PHASES={
    'preparing':(0.0,.03),'archiving':(.03,.15),
    'encoding':(.15,.65),'uploading':(.15,.65),'publishing':(.65,.70),
    'readback':(.70,.88),'decoding':(.70,.88),
    'restoring':(.88,.96),'verifying':(.96,.995),'complete':(.995,.995),
}
PHASE_LABELS={'preparing':'Preparing','archiving':'Archiving','encoding':'Encoding red-X carriers',
    'uploading':'Uploading encrypted carriers','publishing':'Publishing encrypted metadata',
    'readback':'Downloading and verifying readback','decoding':'Decoding verified carriers',
    'restoring':'Restoring verified contents','verifying':'Verifying source and readback',
    'complete':'Finishing verified transfer'}

def number(value,default=0):
    return float(value) if type(value) in (int,float) and math.isfinite(value) and 0<=value<=2**53-1 else default

def format_bytes(value):
    value=number(value)
    for unit in ('B','KiB','MiB','GiB','TiB'):
        if value<1024 or unit=='TiB':return f'{value:,.0f} {unit}' if unit=='B' else f'{value:,.1f} {unit}'
        value/=1024

def format_eta(value):
    if value is None:return 'measuring'
    seconds=max(1,math.ceil(value))
    if seconds<60:return f'{seconds}s'
    minutes,seconds=divmod(seconds,60)
    if minutes<60:return f'{minutes}m {seconds:02d}s'
    hours,minutes=divmod(minutes,60)
    return f'{hours}h {minutes:02d}m'

def destination(receiver,note,parent=None,*,note_name='',folder_name='MachineNote root'):
    if not isinstance(receiver,str) or not re.fullmatch(r'[a-f0-9]{64}',receiver):raise ValueError('Connect the intended account before selecting sources.')
    if not isinstance(note,str) or not re.fullmatch(r'[a-f0-9]{32}',note):raise ValueError('Choose a MachineNote before selecting sources.')
    if parent is not None and (not isinstance(parent,str) or not re.fullmatch(r'[a-f0-9]{18}',parent)):raise ValueError('Refresh the destination folder before selecting sources.')
    return {'receiverId':receiver,'workspaceId':note,'parentKey':parent,'noteName':str(note_name)[:200],'folderName':str(folder_name)[:200]}

def real_path(path):
    path=Path(path)
    for candidate in (path,*path.parents):
        info=candidate.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400:
            raise ValueError('Linked or reparse paths are not selected or browsed. Choose the original file or folder.')
    return path.lstat()

def validate_sources(paths):
    if not isinstance(paths,(list,tuple)) or not 1<=len(paths)<=MAX_SOURCES:raise ValueError('Select between 1 and 100 files or folders.')
    selected=[];seen=set()
    for value in paths:
        path=Path(value)
        if not path.is_absolute():raise ValueError('Select actual absolute local paths.')
        path=Path(os.path.abspath(path))
        info=real_path(path)
        if getattr(info,'st_file_attributes',0)&0x400 or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise ValueError('Linked or special files cannot be uploaded by this picker.')
        if path.name.lower().endswith('.app'):raise ValueError('Use the macOS client to preserve .app bundle metadata.')
        key=os.path.normcase(str(path))
        if key in seen:continue
        seen.add(key);selected.append(str(path))
    for value in selected:
        parents={os.path.normcase(str(p)) for p in Path(value).parents}
        if parents&seen:raise ValueError('Select a folder or its contents, not both. Remove the overlapping selection.')
    return selected

def directory_page(path,offset=0,limit=PAGE_SIZE):
    """Read one bounded directory page without following links or scanning trees."""
    path=Path(path)
    if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=PAGE_SIZE:raise ValueError('Invalid directory page.')
    info=real_path(path)
    if not stat.S_ISDIR(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400:raise ValueError('Choose a real directory.')
    values=[];next_offset=None
    with os.scandir(path) as entries:
        for index,entry in enumerate(entries):
            if index<offset:continue
            if index-offset>=limit:next_offset=index;break
            try:
                info=entry.stat(follow_symlinks=False)
                linked=entry.is_symlink() or bool(getattr(info,'st_file_attributes',0)&0x400)
                kind='folder' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'special'
                allowed=not linked and kind in ('folder','file') and not entry.name.lower().endswith('.app')
                label='Link (unsupported)' if linked else 'macOS app (use Mac)' if entry.name.lower().endswith('.app') else 'Folder' if kind=='folder' else 'File' if kind=='file' else 'Special (unsupported)'
                values.append({'path':str(path/entry.name),'name':entry.name,'kind':kind,'label':label,'selectable':allowed,'expandable':kind=='folder' and allowed})
            except OSError:continue
    return {'entries':sorted(values,key=lambda e:(e['kind']!='folder',e['name'].casefold())),
        'nextOffset':next_offset}

PLATFORM_LABELS={'macos':'macOS','windows':'Windows','linux':'Linux','android':'Android','ios':'iOS','unknown':'Unknown'}

def source_key(item):
    origin=item.get('origin')
    return origin['platform']+':'+origin['deviceId'] if isinstance(origin,dict) and isinstance(origin.get('platform'),str) and isinstance(origin.get('deviceId'),str) else 'unknown'

def source_label(item):
    origin=item.get('origin')
    if not isinstance(origin,dict):return 'Unknown source device'
    return PLATFORM_LABELS.get(origin.get('platform'),'Unknown')+' · device '+str(origin.get('deviceId',''))[:8]+' · '+str(origin.get('architecture','unknown'))

def filter_library(items,*,artifact='all',source='all'):
    """Filter catalog hints while retaining the virtual ancestors of matches."""
    lookup={item['key']:item for item in items};matches=set()
    for key,item in lookup.items():
        target=item.get('applicationPlatform')
        if artifact!='all' and ((artifact=='documents' and target is not None) or (artifact!='documents' and target!=artifact)):continue
        if source!='all' and source_key(item)!=source:continue
        matches.add(key)
    for key in list(matches):
        seen={key};parent=lookup[key].get('parentKey')
        while parent is not None:
            if parent in seen or parent not in lookup:raise ValueError('Refresh the invalid library hierarchy.')
            seen.add(parent);matches.add(parent);parent=lookup[parent].get('parentKey')
    return [item for item in items if item['key'] in matches]

class TransferPresentation:
    """Stage-weighted estimate; real counters remain separate from the percentage.

    The percentage never reaches 100 before the current model reports verified
    completion. ETA is an observed-work estimate, never an advertised tier speed.
    """
    def __init__(self,clock=time.monotonic):
        self.clock=clock;self.started=clock();self.percent=0.0;self.samples=[];self.phase_samples=[];self.phase_key=None
    def snapshot(self,job,progress=None,*,finished=None):
        now=self.clock();progress=progress or {};sources=job.get('sources') or [''];count=len(sources)
        completed=len(job.get('completedSources') or []);completed=min(completed,count)
        state=job.get('state','running');phase=progress.get('phase','preparing');phase=phase if phase in PHASES else 'preparing'
        done=number(progress.get('completed_bytes'));total=number(progress.get('total_bytes'));fraction=min(1.0,done/total) if total else 0.0
        lo,hi=PHASES[phase]
        if phase=='publishing':fraction=0.0 # the transport carries prior upload counters into metadata publication
        estimate=(completed+lo+(hi-lo)*fraction)/count
        success=state=='completed' or finished is True
        if success:self.percent=100.0
        else:self.percent=min(99.0,max(self.percent,estimate*100))
        group='transfer' if phase in ('encoding','uploading') else 'readback' if phase in ('readback','decoding') else phase
        key=(completed,group,total)
        if key!=self.phase_key or self.phase_samples and done<self.phase_samples[-1][1]:self.phase_key=key;self.phase_samples=[]
        self.phase_samples.append((now,done));self.phase_samples=[s for s in self.phase_samples if now-s[0]<=30][-120:]
        phase_eta=None
        if total and len(self.phase_samples)>1:
            elapsed=now-self.phase_samples[0][0];delta=done-self.phase_samples[0][1]
            if elapsed>=2 and delta>0 and done<total:phase_eta=min(365*86400,(total-done)*elapsed/delta)
        self.samples.append((now,self.percent));self.samples=[s for s in self.samples if now-s[0]<=60][-240:]
        overall_eta=None
        if len(self.samples)>1:
            elapsed=now-self.samples[0][0];delta=self.percent-self.samples[0][1]
            if elapsed>=5 and delta>=1 and 0<self.percent<99:overall_eta=min(365*86400,(100-self.percent)*elapsed/delta)
        terminal=success or finished is False or state=='failed'
        if terminal:phase_eta=overall_eta=None
        label='Verified complete' if success else 'Failed — originals retained' if finished is False or state=='failed' else PHASE_LABELS[phase]
        return {'percent':self.percent,'phase':label,'sourceIndex':min(completed+1,count) if not success else count,'sourceCount':count,
            'completedSources':completed,'completedBytes':done,'totalBytes':total,
            'uploadedBytes':number(progress.get('uploaded_bytes')),'downloadedBytes':number(progress.get('downloaded_bytes')),
            'objectsDone':int(number(progress.get('objects_done'))),'objectsTotal':int(number(progress.get('objects_total'))),
            'workers':int(number(progress.get('workers'))),'phaseETA':phase_eta,'overallETA':overall_eta,
            'elapsedSeconds':max(0,now-self.started),'terminal':terminal}

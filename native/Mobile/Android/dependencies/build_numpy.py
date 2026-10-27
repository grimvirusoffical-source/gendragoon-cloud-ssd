#!/usr/bin/env python3
"""Build complete upstream NumPy Android wheel candidates without external BLAS."""
import os
import sys
sys.dont_write_bytecode=True
import argparse
import base64
import csv
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.request
import zipfile

ROOT=Path(__file__).resolve().parent
SOURCE_URL='https://files.pythonhosted.org/packages/95/b0/c7453d0b6e2073c3264468b106ee1563750cecc910965e67357e3698c83e/numpy-2.5.4.tar.gz'
SOURCE_SHA256='9a94cf751c9ad8ebaa835bcd3d40dacf8534ad086b88c38029b65123c7999d2a'
VERSION='2.5.4'
CIBW='4.3.4'
NDK='27.3.13750724'


def include_runtime_notices(path):
    """Retain LLVM's redistribution terms for auditwheel's libc++ copy."""
    sdk=Path(os.environ.get('ANDROID_HOME')or os.environ.get('ANDROID_SDK_ROOT')or '')
    ndk=sdk/'ndk'/NDK
    if not ndk.is_absolute() or NDK not in (ndk/'source.properties').read_text():
        raise RuntimeError('The exact builder NDK is required for its redistribution notices')
    llvm=list((ndk/'toolchains/llvm/prebuilt').glob('*/NOTICE'))
    if len(llvm)!=1:raise RuntimeError('Official LLVM runtime notice is unavailable')
    with zipfile.ZipFile(path)as archive:
        files={name:archive.read(name)for name in archive.namelist()if not name.endswith('/')}
    prefix='numpy-'+VERSION+'.dist-info/'
    if any(name.endswith(('.jws','.p7s'))for name in files):raise RuntimeError('Do not rewrite a separately signed wheel')
    notices={prefix+'licenses/Android-NDK-NOTICE.txt':(ndk/'NOTICE').read_bytes(),prefix+'licenses/Android-NDK-LLVM-NOTICE.txt':llvm[0].read_bytes()}
    files.update(notices);record=prefix+'RECORD';stream=io.StringIO(newline='');writer=csv.writer(stream,lineterminator='\n')
    for name,data in sorted(files.items()):
        if name!=record:writer.writerow([name,'sha256='+base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('='),len(data)])
    writer.writerow([record,'','']);files[record]=stream.getvalue().encode()
    temporary=path.with_suffix('.repack')
    with zipfile.ZipFile(temporary,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9)as archive:
        for name,data in sorted(files.items()):
            info=zipfile.ZipInfo(name,(2026,10,26,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;archive.writestr(info,data)
    temporary.replace(path)
    return {'version':NDK,'notices':{name:hashlib.sha256(data).hexdigest()for name,data in notices.items()}}


def verify_wheel(path,abi):
    sys.path.insert(0,str(ROOT.parent))
    from check_native_pages import inspect_elf
    from prepare_linkage import needed_libraries
    records=[]
    with zipfile.ZipFile(path)as archive:
        names=archive.namelist()
        if len(names)>20000 or len(names)!=len(set(names)):raise RuntimeError('Invalid candidate wheel members')
        metadata=archive.read('numpy-'+VERSION+'.dist-info/METADATA').decode()
        if any(word in metadata.lower()for word in ('requires-dist: chaquopy-openblas','requires-dist: chaquopy-libgfortran')):
            raise RuntimeError('The candidate still depends on incompatible external BLAS/Fortran')
        required=['numpy/__init__.py','numpy/linalg/__init__.py','numpy/fft/__init__.py','numpy/random/__init__.py']
        if any(name not in names for name in required):raise RuntimeError('Required upstream NumPy modules are missing')
        if not any('.dist-info/licenses/'in name for name in names):raise RuntimeError('Upstream license notices are required')
        for name in names:
            if archive.getinfo(name).file_size>128*1024*1024:raise RuntimeError('Candidate member exceeds bounded inspection limit')
            if name.endswith('.so')or '.so.'in name:
                data=archive.read(name)
                if data[:4]!=b'\x7fELF':continue
                record={'path':name,**inspect_elf(data)}
                if record['machine']!=(183 if abi=='arm64_v8a'else 62)or not record['aligned16KiB']:raise RuntimeError('A candidate native module has the wrong architecture or 16 KiB alignment')
                if b'libopenblas'in data or b'libgfortran'in data:raise RuntimeError('Candidate ELF still references an external BLAS/Fortran runtime')
                record['needed']=needed_libraries(data)
                if name.startswith('numpy/')and '.cpython-313-'in name and 'libpython3.13.so'not in record['needed']:
                    raise RuntimeError('Android Python extensions must explicitly link libpython3.13.so: '+name)
                records.append(record)
        for module in ('_multiarray_umath','lapack_lite','_umath_linalg'):
            if not any(module in row['path']for row in records):raise RuntimeError('Required complete NumPy core/linear-algebra native module missing: '+module)
    return {'wheel':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size,'libraries':records,'externalBLAS':False,'externalLAPACK':False,'lapackLiteRetained':True,'deviceRuntimeVerified':False}


def build(work,abi):
    work=Path(work).resolve()
    if work.exists():raise RuntimeError('Use a new isolated dependency build directory')
    if importlib.metadata.version('cibuildwheel')!=CIBW:raise RuntimeError('Install the exact reviewed cibuildwheel version')
    work.mkdir(parents=True,mode=0o700)
    source=work/'numpy.tar.gz'
    with urllib.request.urlopen(SOURCE_URL,timeout=60)as response,source.open('xb')as output:
        size=0
        while True:
            block=response.read(1024*1024)
            if not block:break
            size+=len(block)
            if size>64*1024*1024:raise RuntimeError('Upstream source archive exceeds its limit')
            output.write(block)
    if hashlib.sha256(source.read_bytes()).hexdigest()!=SOURCE_SHA256:raise RuntimeError('Official NumPy source SHA-256 failed')
    with tarfile.open(source,'r:gz')as archive:
        if len(archive.getmembers())>50000:raise RuntimeError('Upstream source member count exceeds its limit')
        archive.extractall(work/'source',filter='data')
    project=work/'source'/('numpy-'+VERSION)
    output=work/'wheelhouse';output.mkdir()
    env=os.environ.copy();env.update(CIBW_BUILD='cp313-android_'+abi,ANDROID_API_LEVEL='28',CIBW_CACHE_PATH=str(work/'cache'))
    subprocess.run([sys.executable,'-m','cibuildwheel',str(project),'--platform','android','--archs',abi,'--config-file',str(ROOT/'cibuildwheel.toml'),'--output-dir',str(output)],env=env,cwd=ROOT.parents[3],check=True,timeout=3600)
    wheels=list(output.glob('numpy-'+VERSION+'-cp313-cp313-android_*_'+abi+'.whl'))
    if len(wheels)!=1:raise RuntimeError('Expected exactly one architecture-bound NumPy candidate')
    notices=include_runtime_notices(wheels[0])
    result={'schema':1,'numpyVersion':VERSION,'pythonVersion':'3.13','abi':abi,'sourceURL':SOURCE_URL,'sourceSHA256':SOURCE_SHA256,'cibuildwheelVersion':CIBW,'configSHA256':hashlib.sha256((ROOT/'cibuildwheel.toml').read_bytes()).hexdigest(),'ndkRuntime':notices,'candidate':verify_wheel(wheels[0],abi)}
    (output/'provenance.json').write_text(json.dumps(result,indent=2)+'\n')
    (output/'SHA256SUMS').write_text(result['candidate']['sha256']+'  '+wheels[0].name+'\n')
    # No source archive, private vendor, credentials or build cache is published.
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--work-dir',type=Path,required=True);parser.add_argument('--abi',choices=('arm64_v8a','x86_64'),required=True);args=parser.parse_args();print(json.dumps(build(args.work_dir,args.abi),indent=2))

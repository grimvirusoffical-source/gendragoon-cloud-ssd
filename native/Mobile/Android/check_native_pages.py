#!/usr/bin/env python3
"""Audit every packaged ELF, including Chaquopy's nested requirement archives."""
import os
import sys
sys.dont_write_bytecode=True
import argparse
import io
import json
from pathlib import Path
import struct
import zipfile

LIMIT=1024*1024*1024


def inspect_elf(data):
    if len(data)<64 or data[:6]!=b'\x7fELF\x02\x01':
        raise ValueError('Expected a bounded little-endian 64-bit Android ELF')
    offset=struct.unpack_from('<Q',data,32)[0]
    size,count=struct.unpack_from('<HH',data,54)
    if size<56 or not 1<=count<=4096 or offset+size*count>len(data):
        raise ValueError('Invalid ELF program header table')
    loads=[struct.unpack_from('<IIQQQQQQ',data,offset+i*size)for i in range(count)if struct.unpack_from('<I',data,offset+i*size)[0]==1]
    if not loads:raise ValueError('ELF has no load segments')
    return {'machine':struct.unpack_from('<H',data,18)[0], 'minimumLoadAlignment':min(x[7]for x in loads),
            'aligned16KiB':all(x[7]>=16384 and (x[2]-x[3])%16384==0 for x in loads)}


def audit(path):
    path=Path(path)
    if path.stat().st_size>512*1024*1024:raise ValueError('APK exceeds audit input limit')
    report=[];budget=[0]
    def visit(raw,prefix,depth):
        if depth>4:raise ValueError('Nested runtime archive depth exceeds audit limit')
        with zipfile.ZipFile(io.BytesIO(raw))as archive:
            names=archive.namelist()
            if len(names)>100000 or len(names)!=len(set(names)):raise ValueError('Excessive or duplicate archive members')
            for item in archive.infolist():
                if item.is_dir():continue
                if not 0<=item.file_size<=128*1024*1024:raise ValueError('Runtime member exceeds audit limit')
                budget[0]+=item.file_size
                if budget[0]>LIMIT:raise ValueError('Unpacked runtime exceeds audit limit')
                with archive.open(item)as stream:
                    header=stream.read(6)
                    if header.startswith(b'\x7fELF')or header.startswith(b'PK\x03\x04'):
                        data=header+stream.read()
                    else:continue
                name=prefix+'!/'+item.filename
                if header.startswith(b'\x7fELF'):
                    record={'path':name,**inspect_elf(data)}
                    if record['machine']not in(62,183):raise ValueError('Unexpected packaged native architecture')
                    report.append(record)
                else:visit(data,name,depth+1)
    visit(path.read_bytes(),path.name,0)
    if not report or {x['machine']for x in report}!={62,183}:raise ValueError('Audit did not find both supported packaged architectures')
    return {'schema':1,'artifact':path.name,'libraries':report,'compatible16KiB':all(x['aligned16KiB']for x in report)}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('apk',type=Path);parser.add_argument('--output',type=Path);args=parser.parse_args()
    result=audit(args.apk);encoded=json.dumps(result,indent=2)+'\n'
    if args.output:args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(encoded)
    print(encoded,end='')
    if not result['compatible16KiB']:parser.exit(1,'Packaged native dependency alignment is incompatible with 16 KiB Android devices. Distribution gate failed.\n')

if __name__=='__main__':main()

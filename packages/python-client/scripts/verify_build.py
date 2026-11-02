"""Reviewed offline build + archive/source check. No publishing or network."""
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
import tarfile
import zipfile

class BlockedSocket(socket.socket):
    def __init__(self, *args, **kwargs): raise RuntimeError('network forbidden during local build')
socket.socket = BlockedSocket

root = Path(__file__).resolve().parents[1]
out = Path(sys.argv[1]).resolve()
out.mkdir(exist_ok=False)
os.chdir(root)
from hatchling.build import build_wheel, build_sdist
wheel, source = out/build_wheel(str(out)), out/build_sdist(str(out))
expected = {p.relative_to(root).as_posix():p.read_bytes() for p in (root/'delta_witness').glob('*.py')}
with zipfile.ZipFile(wheel) as archive:
    assert sum(i.file_size for i in archive.infolist()) < 1_000_000
    for name, data in expected.items():
        assert archive.read(name) == data, 'wheel/source mismatch'
    assert {n for n in archive.namelist() if n.startswith('delta_witness/')} == set(expected)
with tarfile.open(source) as archive:
    members = archive.getmembers()
    assert all(m.isfile() or m.isdir() for m in members)
    assert sum(m.size for m in members) < 1_000_000
    for name, data in expected.items():
        matches = [m for m in members if m.name.endswith('/'+name)]
        assert len(matches) == 1 and archive.extractfile(matches[0]).read() == data
sys.path.insert(0, str(wheel))
import delta_witness
assert delta_witness.__file__.startswith(str(wheel))
import httpx
from unittest.mock import patch
with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={'price':1,'fixture':True}))) as local:
    with patch('httpx.stream', side_effect=local.stream):
        assert delta_witness.DeltaWitness().quote() == {'price':1,'fixture':True}
print(json.dumps({'artifacts':[{'file':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size} for p in (wheel,source)],
    'source_files':len(expected),'wheel_source_equal':True,'sdist_source_equal':True,'wheel_import_and_httpx_smoke':True,'network':'blocked socket constructor'}))

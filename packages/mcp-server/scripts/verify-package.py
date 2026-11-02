"""Local artifact/source equality, then safe extraction into a fresh test folder."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile

root = Path(__file__).resolve().parents[1]
archive_path, output = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
output.mkdir(exist_ok=False)
with tarfile.open(archive_path) as archive:
    members = archive.getmembers()
    assert all(member.isfile() and member.size < 1_000_000 for member in members)
    expected = {'package.json', 'README.md', 'LICENSE', *('dist/'+p.name for p in (root/'dist').iterdir() if p.is_file())}
    assert {m.name.removeprefix('package/') for m in members} == expected
    for member in members:
        path = PurePosixPath(member.name)
        assert path.parts[0] == 'package' and '..' not in path.parts and not path.is_absolute()
        relative = path.relative_to('package')
        data = archive.extractfile(member).read()
        assert data == (root/str(relative)).read_bytes()
        destination = output/str(relative)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open('xb') as file:
            file.write(data)
    assert (output/'dist/order-client.js').read_bytes() == (root.parent/'js-client/src/index.js').read_bytes()
print(json.dumps({'archive_sha256':hashlib.sha256(archive_path.read_bytes()).hexdigest(), 'files_equal':len(members),
    'shared_sdk_byte_equal':True, 'extracted':str(output)}))

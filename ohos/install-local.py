#!/usr/bin/env python3
"""Extract a local candidate and copy pinned OHOS dependencies without npm/global installation."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--archive', type=Path, required=True)
parser.add_argument('--dependencies-source', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True, help='new directory, never an existing installation')
args = parser.parse_args()
archive = args.archive.resolve()
expected = archive.with_name(archive.name + '.sha256').read_text().split()[0]
actual = hashlib.sha256(archive.read_bytes()).hexdigest()
if expected != actual:
    parser.error('local candidate archive checksum mismatch')
output = args.output.resolve()
if output.exists():
    parser.error('output already exists; use a new independent directory')
with tarfile.open(archive) as tar:
    for member in tar:
        if not member.name.startswith('package/') or member.issym() or member.islnk():
            parser.error('candidate must contain regular package files, not links or alternate roots')
    output.mkdir(parents=True)
    tar.extractall(output, filter='data')
release = json.loads((root / 'ohos/release.json').read_text())
metadata = json.loads((output / 'package/package.json').read_text())
if (metadata['name'], metadata['version']) != ('@deepseek-ai/dsh', release['version']):
    parser.error('local candidate identity differs from reviewed source')
subprocess.run([sys.executable, str(root / 'ohos/local-dependencies.py'),
                '--source', str(args.dependencies_source.resolve()),
                '--output', str(output / 'package/node_modules')], check=True)
(output / 'local-install.json').write_text(json.dumps({
    'archive': archive.name, 'sha256': actual, 'version': metadata['version'],
    'dependencies': release['dependencies'], 'existing_installation_modified': False,
}, indent=2) + '\n')
print(f'Prepared isolated local runtime at {output / "package"}')

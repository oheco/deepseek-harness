#!/usr/bin/env python3
"""Copy pinned, already-installed OHOS dependencies for isolated local validation."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, required=True, help='read-only node_modules containing adapted dependencies')
parser.add_argument('--output', type=Path, required=True, help='fresh private node_modules directory')
parser.add_argument('--connect-checkout', action='store_true', help='replace only generated pnpm dependency directories with links to the copies')
parser.add_argument('--reuse-copies', action='store_true', help='verify existing copies against the recorded tree hashes instead of copying again')
args = parser.parse_args()
release = json.loads((root / 'ohos/release.json').read_text())
expected = dict(release['dependencies'])
expected['@vscode/ripgrep-openharmony-arm64'] = expected['@vscode/ripgrep']
# Verify all inputs before writing anything. No shared installed dependency is modified.
for name, version in expected.items():
    metadata = json.loads((args.source / name / 'package.json').read_text())
    if metadata['name'] != name or metadata['version'] != version:
        raise ValueError(f'expected {name}@{version}, found {metadata["name"]}@{metadata["version"]}')
record_path = args.output.parent / (args.output.name + '-inputs.json')
previous = json.loads(record_path.read_text()) if args.reuse_copies else {}
if not args.reuse_copies:
    args.output.mkdir(parents=True, exist_ok=False)
records = {}
for name, version in expected.items():
    destination = args.output / name
    if not args.reuse_copies:
        shutil.copytree(args.source / name, destination)
    digest = hashlib.sha256()
    for path in sorted(destination.rglob('*')):
        # pnpm regenerates convenience command shims when workspace links change.
        if path.is_file() and '.bin' not in path.relative_to(destination).parts:
            digest.update(str(path.relative_to(destination)).encode() + b'\0')
            digest.update(path.read_bytes())
    records[name] = {'version': version, 'tree_sha256': digest.hexdigest()}
    if args.reuse_copies and records[name] != previous.get(name):
        raise ValueError(f'private dependency copy changed: {name}')
    if args.connect_checkout and name in release['dependencies']:
        for candidate in (root / 'node_modules/.pnpm').glob(name.replace('/', '+') + '@*/node_modules/' + name):
            if candidate.is_symlink():
                candidate.unlink()
            else:
                shutil.rmtree(candidate)
            candidate.symlink_to(destination.resolve(), target_is_directory=True)
if not args.reuse_copies:
    record_path.write_text(json.dumps(records, indent=2) + '\n')
print(f'Prepared {len(records)} pinned OHOS dependencies; existing installation unchanged')

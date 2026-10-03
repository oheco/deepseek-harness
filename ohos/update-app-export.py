#!/usr/bin/env python3
"""Apply local source updates without overwriting DevEco signing or user edits.

Only template files changed since the original project ZIP are candidates.
Generated runtime defaults, app identity and the user-owned root build profile
are excluded: identity/SDK fields must be edited separately without touching
signing material.

A file the export carries but the baseline ZIP does not match is normally a
user edit and refuses the whole run. The sync state written beside the export
records every path this tool has written or verified as equal to the source, so
a file updated by an earlier sync is still updatable while a genuine user edit
is not. Every conflict is detected before anything is written.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

PROTECTED = {'build-profile.json5', 'AppScope/app.json5',
             'entry/src/main/ets/config/RuntimeDefaults.ets'}
GENERATED = {'.git', '.hvigor', '.cxx', 'build', 'node_modules', 'oh_modules', '__pycache__', 'runtime'}
STATE_NAME = 'LOCAL-SYNC.json'


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha_file(path):
    return sha_bytes(path.read_bytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--export', dest='destination', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    source = Path(__file__).resolve().parent / 'app'
    destination = args.destination.resolve()
    state_path = destination / STATE_NAME
    state = json.loads(state_path.read_text()) if state_path.is_file() else {}
    synced = state.get('files', {})

    changes = []
    verified = {}
    with zipfile.ZipFile(args.baseline) as baseline:
        names = set(baseline.namelist())
        for file in sorted(source.rglob('*')):
            relative = file.relative_to(source)
            if not file.is_file() or set(relative.parts) & GENERATED or relative.as_posix() in PROTECTED:
                continue
            if file.is_symlink():
                raise ValueError(f'source symlink cannot be synchronized: {relative}')
            key = relative.as_posix()
            name = 'DSHApp/' + key
            data = file.read_bytes()
            digest = sha_bytes(data)
            original = baseline.read(name) if name in names else None
            original_hash = sha_bytes(original) if original is not None else None
            verified[key] = digest
            if data == original:
                continue
            target = destination / relative
            if target.is_symlink():
                raise ValueError(f'export symlink cannot be overwritten: {key}')
            if target.exists():
                current = sha_file(target)
                if current == digest:
                    continue
                if current != original_hash and current != synced.get(key):
                    raise ValueError(f'user-modified export file; merge explicitly: {key}')
            elif original is not None:
                raise ValueError(f'user removed export file; refusing to recreate: {key}')
            changes.append((file, target, key, digest))

    # A file this tool wrote earlier and the source no longer produces is retired:
    # only the tool's own previous output is removed, never a user file.
    source_keys = set(verified)
    removals = []
    for key, recorded in sorted(synced.items()):
        if key in source_keys or key in PROTECTED or set(Path(key).parts) & GENERATED:
            continue
        target = destination / key
        if not target.is_file():
            continue
        if sha_file(target) != recorded:
            raise ValueError(f'retired file was modified by the user; remove it yourself: {key}')
        removals.append((target, key))

    profile = destination / 'build-profile.json5'
    profile_before = sha_file(profile)
    for target, key in removals:
        print(('REMOVE ' if args.apply else 'PLAN REMOVE ') + key)
        if args.apply:
            target.unlink()
    for file, target, key, digest in changes:
        print(('UPDATE ' if args.apply else 'PLAN ') + key)
        if args.apply:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, target)
            if sha_file(target) != digest:
                raise ValueError(f'copy verification failed: {key}')
    if sha_file(profile) != profile_before:
        raise ValueError('user-owned root build profile changed during synchronization')
    if args.apply:
        synced.update(verified)
        for _, key in removals:
            synced.pop(key, None)
        state_path.write_text(json.dumps({
            'kind': 'local project synchronization state',
            'source_commit': state.get('source_commit', ''),
            'files': dict(sorted(synced.items())),
        }, ensure_ascii=False, indent=2) + '\n')
    retired = f' and {len(removals)} retired file(s)' if removals else ''
    print(f'{len(changes)} file(s){retired}; signing/SDK profile and runtime defaults preserved byte-for-byte.')


if __name__ == '__main__':
    main()

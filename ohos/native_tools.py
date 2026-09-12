"""Prepare pinned upstream build tools in private copies on HarmonyOS."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile


def prepare(root, output):
    inputs = root / 'tpr/ohos-build-tools'
    records = json.loads((inputs / 'SOURCES.json').read_text())
    packages = {}
    lock = (root / 'pnpm-lock.yaml').read_text()
    for entry in records:
        archive = inputs / entry['archive']
        if hashlib.sha256(archive.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError(f'build input checksum mismatch: {archive}')
        if entry['lockfile_matched'] and entry['integrity'] not in lock:
            raise ValueError(f'build input no longer matches pnpm-lock.yaml: {entry["name"]}')
        destination = output / (entry['name'].replace('@', '').replace('/', '__') + '-' + entry['version'])
        destination.mkdir(parents=True, exist_ok=False)
        with tarfile.open(archive) as tar:
            tar.extractall(destination, filter='data')
        package = destination / 'package'
        metadata = json.loads((package / 'package.json').read_text())
        if (metadata['name'], metadata['version']) != (entry['name'], entry['version']):
            raise ValueError(f'build input identity mismatch: {archive}')
        for binary in package.rglob('*.node'):
            if binary.read_bytes()[:4] != b'\x7fELF':
                raise ValueError(f'expected ELF addon: {binary}')
            signed = binary.with_name(binary.name + '.signed')
            subprocess.run(['binary-sign-tool', 'sign', '-inFile', str(binary), '-outFile', str(signed),
                            '-selfSign', '1'], check=True)
            os.replace(signed, binary)
            binary.chmod(0o755)
        packages[(entry['name'], entry['version'])] = package
    return packages


def connect(root, packages):
    parents = {'@esbuild/openharmony-arm64': 'esbuild', '@rolldown/binding-openharmony-arm64': 'rolldown',
               '@rollup/rollup-openharmony-arm64': 'rollup', '@oxc-resolver/binding-openharmony-arm64': 'oxc-resolver'}
    for (name, version), package in packages.items():
        if name not in parents:
            continue
        matches = list((root / 'node_modules/.pnpm').glob(parents[name] + '@' + version))
        matches += list((root / 'node_modules/.pnpm').glob(parents[name] + '@' + version + '_*'))
        if not matches:
            raise ValueError(f'locked build-tool consumer missing: {parents[name]}@{version}')
        for parent in matches:
            link = parent / 'node_modules' / name
            link.parent.mkdir(parents=True, exist_ok=True)
            if link.is_symlink():
                link.unlink()
            elif link.exists():
                shutil.rmtree(link)
            link.symlink_to(package, target_is_directory=True)
    wasm = packages[('lightningcss-wasm', '1.32.0')]
    css = (root / 'node_modules/lightningcss').resolve()
    if json.loads((css / 'package.json').read_text())['version'] != '1.32.0':
        raise ValueError('Lightning CSS WASM adapter requires lightningcss 1.32.0')
    # pnpm installs with copy semantics; replacing this entry cannot mutate the input store.
    entry = css / 'node/index.js'
    entry.unlink()
    entry.write_text('module.exports = require(' + json.dumps(str(wasm / 'wasm-node.cjs')) + ');\n')

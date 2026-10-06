"""Prepare pinned upstream build tools in private copies on HarmonyOS."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile


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
        if entry['name'] == 'esbuild-wasm' and f'\n  esbuild@{entry["version"]}:\n' not in lock:
            raise ValueError(f'esbuild WASM version has no matching locked consumer: {entry["version"]}')
        if entry['name'] == '@oxlint-tsgolint/openharmony-arm64' and f'\n  oxlint-tsgolint@{entry["version"]}:\n' not in lock:
            raise ValueError(f'tsgolint source version has no matching locked consumer: {entry["version"]}')
        destination = output / (entry['name'].replace('@', '').replace('/', '__') + '-' + entry['version'])
        destination.mkdir(parents=True, exist_ok=False)
        with tarfile.open(archive) as tar:
            tar.extractall(destination, filter='data')
        package = destination / 'package'
        metadata = json.loads((package / 'package.json').read_text())
        if (metadata['name'], metadata['version']) != (entry['name'], entry['version']):
            raise ValueError(f'build input identity mismatch: {archive}')
        if entry['name'] == '@oxlint-tsgolint/openharmony-arm64':
            build_tsgolint(package)
        # pnpm also bundles unused addons for other hosts; copy mode uses its JavaScript path.
        binaries = list(package.rglob('*.node')) if entry['origin'] == 'upstream OHOS binary' else []
        for binary in binaries:
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
               '@rollup/rollup-openharmony-arm64': 'rollup', '@oxc-resolver/binding-openharmony-arm64': 'oxc-resolver',
               '@oxlint-tsgolint/openharmony-arm64': 'oxlint-tsgolint',
               '@oxlint/binding-openharmony-arm64': 'oxlint'}
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
    connect_esbuild_wasm(root, packages[('esbuild-wasm', '0.21.5')])


def connect_esbuild_wasm(root, package):
    """Select the unchanged WASM API only for VitePress's locked esbuild 0.21.5."""
    metadata = json.loads((package / 'package.json').read_text())
    if (metadata['name'], metadata['version']) != ('esbuild-wasm', '0.21.5'):
        raise ValueError('esbuild WASM adapter requires esbuild-wasm 0.21.5')
    inputs = root / 'tpr/ohos-build-tools'
    source = next(entry for entry in json.loads((inputs / 'SOURCES.json').read_text())
                  if (entry['name'], entry['version']) == ('esbuild-wasm', '0.21.5'))
    archive = inputs / source['archive']
    if hashlib.sha256(archive.read_bytes()).hexdigest() != source['sha256']:
        raise ValueError('esbuild WASM archive checksum mismatch')
    with tarfile.open(archive) as tar:
        upstream_cli = tar.extractfile('package/bin/esbuild').read()
    cli = package / 'bin/esbuild'
    original_cli = cli.with_name('esbuild.upstream.cjs')
    current_cli = original_cli if original_cli.exists() else cli
    if current_cli.read_bytes() != upstream_cli:
        raise ValueError('esbuild WASM upstream CLI differs from its pinned archive')
    if not original_cli.exists():
        cli.rename(original_cli)
        cli.write_text("""// Keep esbuild's stdout workaround from recursing through OHOS SyncWriteStream.
const nativeWriteSync = require('node:fs').writeSync;
if (process.platform === 'openharmony') {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.constructor.name !== 'SyncWriteStream') continue;
    stream._write = function(chunk, encoding, callback) {
      try {
        let offset = 0;
        while (offset < chunk.length) {
          const written = nativeWriteSync(this.fd, chunk, offset, chunk.length - offset);
          if (written === 0) throw new Error('esbuild WASM output write made no progress');
          offset += written;
        }
      } catch (error) {
        callback(error);
        return;
      }
      callback();
    };
  }
}
require('./esbuild.upstream.cjs');
""")
    modules = (root / 'node_modules').resolve()
    parents = list((modules / '.pnpm').glob('esbuild@0.21.5'))
    parents += list((modules / '.pnpm').glob('esbuild@0.21.5_*'))
    if not parents:
        raise ValueError('locked esbuild 0.21.5 consumer missing')
    for parent in parents:
        consumer = parent / 'node_modules/esbuild'
        if json.loads((consumer / 'package.json').read_text())['version'] != '0.21.5':
            raise ValueError('esbuild WASM consumer version mismatch')
        entry = consumer / 'lib/main.js'
        if not entry.resolve().is_relative_to(modules):
            raise ValueError('esbuild WASM adapter requires a local dependency copy')
        # Unlink before writing so even a linked installation cannot change its store bytes.
        entry.unlink()
        entry.write_text('module.exports = require(' + json.dumps(str(package.resolve() / 'lib/main.js')) + ');\n')


def build_tsgolint(package):
    """Compile and sign the pinned type-aware lint backend without network access."""
    metadata = json.loads((package / 'package.json').read_text())
    if (metadata['name'], metadata['version']) != ('@oxlint-tsgolint/openharmony-arm64', '7.0.2001'):
        raise ValueError('tsgolint source adapter requires version 7.0.2001')
    source = package / 'source'
    env = dict(os.environ, GOTOOLCHAIN='local', GOPROXY='off', GOSUMDB='off',
               CGO_ENABLED='0', GOMAXPROCS='2')
    target = json.loads(subprocess.check_output(['go', 'env', '-json', 'GOOS', 'GOARCH', 'GOVERSION'],
                                               cwd=source, env=env, text=True))
    if target != {'GOOS': 'ohos', 'GOARCH': 'arm64', 'GOVERSION': 'go1.27.1'}:
        raise ValueError(f'tsgolint requires the pinned native Go 1.27.1 OHOS ARM64 toolchain: {target}')
    binary = package / 'tsgolint'
    with tempfile.TemporaryDirectory(prefix='tsg-b-', dir=os.environ['TMPDIR']) as temporary:
        env.update(TMPDIR=temporary, GOMODCACHE=str(Path(temporary) / 'gomodcache'))
        subprocess.run(['go', 'build', '-mod=vendor', '-buildvcs=false', '-p=2', '-ldflags=-s -w',
                        '-trimpath', '-o', str(binary), './cmd/tsgolint'], cwd=source, env=env, check=True)
    if binary.read_bytes()[:4] != b'\x7fELF':
        raise ValueError('tsgolint native build did not produce an ELF executable')
    signed = binary.with_name(binary.name + '.signed')
    subprocess.run(['binary-sign-tool', 'sign', '-inFile', str(binary), '-outFile', str(signed),
                    '-selfSign', '1'], check=True)
    os.replace(signed, binary)
    binary.chmod(0o755)

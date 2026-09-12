#!/usr/bin/env python3
"""Build the npm application archive from a locked production deployment."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--deployment', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--system-addon', type=Path, default=root / 'native/system/packages/openharmony-arm64/bin/system.node')
args = parser.parse_args()
release = json.loads((root / 'ohos/release.json').read_text())
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False)
package = output / 'package'
runtime = package / 'runtime'
modules = runtime / 'node_modules'
modules.mkdir(parents=True)


def copy_tree(source, destination):
    for directory, dirs, files in os.walk(source):
        dirs[:] = [name for name in dirs if name not in ['.bin', '.pnpm']]
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError(f'deployment contains a package symlink: {path}')
        for name in files:
            path = Path(directory) / name
            target = destination / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)


def supported(values, platform):
    if not values:
        return True
    if '!' + platform in values:
        return False
    return platform in values or all(value.startswith('!') for value in values)


source_modules = args.deployment.resolve() / 'node_modules'
if not (source_modules / '@deepseek-ai/dsh/package.json').is_file():
    parser.error('use the dsh-ohos-runtime deployment, whose closure includes the CLI package')
if not (source_modules / '@deepseek-ai/dsh/lib/bin.js').is_file():
    parser.error('deployment has no built dsh entry; finish and deploy the build before packaging')
manifest_paths = sorted(source_modules.glob('*/package.json')) + sorted(source_modules.glob('@*/*/package.json'))
versions = {}
source_versions = {}
for pattern in ['packages/*/*/package.json', 'apps/*/package.json', 'vendor/*/package.json', 'native/system/packages/*/package.json']:
    for path in root.glob(pattern):
        metadata = json.loads(path.read_text())
        source_versions[metadata['name']] = metadata['version']
for manifest_path in manifest_paths:
    metadata = json.loads(manifest_path.read_text())
    name = metadata['name']
    if name in release['dependencies']:
        continue
    if not supported(metadata.get('os'), 'openharmony') or not supported(metadata.get('cpu'), 'arm64'):
        continue
    destination = modules / name
    copy_tree(manifest_path.parent, destination)
    versions[name] = metadata['version']

addon = args.system_addon.resolve()
header = addon.read_bytes()[:20]
if header[:6] != b'\x7fELF\x02\x01' or header[18:20] != b'\xb7\x00':
    parser.error('the system addon must be the signed HarmonyOS ARM64 ELF payload')
addon_package = modules / '@deepseek-ai/node-addon-system-openharmony-arm64'
copy_tree(root / 'native/system/packages/openharmony-arm64', addon_package)
(addon_package / 'bin').mkdir(parents=True, exist_ok=True)
shutil.copyfile(addon, addon_package / 'bin/system.node')
shutil.copyfile(root / 'native/system/LICENSE', addon_package / 'LICENSE')
versions['@deepseek-ai/node-addon-system-openharmony-arm64'] = json.loads((addon_package / 'package.json').read_text())['version']
versions.update(release['dependencies'])
versions['@deepseek-ai/dsh'] = release['version']
print(f'Copied {len(versions)} runtime packages; preparing archive metadata', flush=True)

for manifest_path in sorted(modules.glob('*/package.json')) + sorted(modules.glob('@*/*/package.json')):
    metadata = json.loads(manifest_path.read_text())
    for field in ['devDependencies', 'scripts', 'packageManager']:
        metadata.pop(field, None)
    for field in ['dependencies', 'peerDependencies', 'optionalDependencies']:
        for name, value in metadata.get(field, {}).items():
            if name in release['dependencies']:
                metadata[field][name] = versions[name]
            elif 'file:' in value or value.startswith(('workspace:', 'link:')):
                version = versions.get(name)
                if version is None and (field == 'optionalDependencies' or metadata.get('peerDependenciesMeta', {}).get(name, {}).get('optional')):
                    version = source_versions.get(name)
                if version is None:
                    raise ValueError(f'unresolved workspace dependency: {metadata["name"]} -> {name}')
                metadata[field][name] = version
    if metadata['name'] == '@deepseek-ai/dsh':
        metadata['version'] = release['version']
        closure = json.loads((root / 'ohos/runtime/package.json').read_text())['dependencies']
        missing = set(closure) - set(versions)
        if missing:
            raise ValueError(f'deployment is missing required runtime packages: {sorted(missing)}')
        metadata['dependencies'] = {name: versions[name] for name in closure if name != '@deepseek-ai/dsh' and name in versions}
        metadata['dependencies'].update(release['dependencies'])
        metadata.pop('dsh', None)
    manifest_path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + '\n')

(package / 'package.json').write_text(json.dumps({
    'name': '@deepseek-ai/dsh', 'version': release['version'],
    'description': 'DeepSeek Harness CLI and Web profiles for HarmonyOS PC ARM64',
    'type': 'module', 'bin': {'dsh': 'bin/dsh'}, 'license': 'MIT',
    'repository': {'type': 'git', 'url': 'https://github.com/oheco/deepseek-harness'},
    'os': ['openharmony'], 'cpu': ['arm64'], 'engines': {'node': '>=24'},
    'dependencies': release['dependencies'],
}, indent=2) + '\n')
(package / 'bin').mkdir()
(package / 'bin/dsh').write_text('#!/usr/bin/zsh\nexec node --expose-internals "${0:A:h}/../runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n')
for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
    shutil.copyfile(root / name, package / name)
shutil.copyfile(root / 'ohos/README.md', package / 'README.md')
shutil.copyfile(root / 'ohos/README.zh.md', package / 'README.zh.md')
shutil.copyfile(root / 'pnpm-lock.yaml', package / 'pnpm-lock.source.yaml')
shutil.copyfile(root / 'ohos/release.json', package / 'release.json')
(package / 'build-info.json').write_text(json.dumps({
    'source_dirty': bool(subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=normal'], cwd=root, text=True).strip()),
    'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
    'upstream_commit': release['upstream_commit'],
    'package_version': release['version'],
    'lock_sha256': hashlib.sha256((root / 'pnpm-lock.yaml').read_bytes()).hexdigest(),
    'system_addon_sha256': hashlib.sha256(addon.read_bytes()).hexdigest(),
    'packages': dict(sorted(versions.items())),
}, indent=2) + '\n')
archive = output / f"deepseek-harness-{release['version']}.tgz"
print(f'Writing {archive}', flush=True)
with archive.open('wb') as stream, gzip.GzipFile(fileobj=stream, mode='wb', mtime=0, filename='') as compressed:
    with tarfile.open(fileobj=compressed, mode='w|') as tar:
        for path in sorted(package.rglob('*')):
            if not path.is_file():
                continue
            relative = path.relative_to(package)
            info = tar.gettarinfo(str(path), 'package/' + str(relative))
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ''
            info.mode = 0o755 if str(relative) == 'bin/dsh' or path.suffix == '.node' else 0o644
            with path.open('rb') as source:
                tar.addfile(info, source)
sha = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_name(archive.name + '.sha256').write_text(f'{sha}  {archive.name}\n')
print(f'BUILT {archive.name} {archive.stat().st_size} {sha}; run native installed-package acceptance before release')

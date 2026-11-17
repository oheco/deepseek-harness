#!/usr/bin/env python3
"""Generate the Web/CLI deploy manifest from current upstream workspace inputs."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
packages = {}
for pattern in ('packages/*/*/package.json', 'apps/*/package.json', 'vendor/*/package.json',
                'native/system/packages/*/package.json'):
    for path in root.glob(pattern):
        metadata = json.loads(path.read_text())
        packages[metadata['name']] = metadata
# The upstream manifest includes dynamically selected preset plugins. Reuse its
# dependency list, not its Python packaging or executable build.
seeds = json.loads((root / 'python/sdk-runtime/package.json').read_text())['dependencies']
pending = [*seeds, '@deepseek-ai/dsh-web-frontend']
selected = set()
while pending:
    name = pending.pop()
    if name in selected or name not in packages:
        continue
    if name == '@deepseek-ai/dsh-desktop':
        raise ValueError('desktop entered the Web runtime dependency closure')
    metadata = packages[name]
    unsupported = False
    for field, target in (('os', 'openharmony'), ('cpu', 'arm64')):
        values = metadata.get(field, [])
        if '!' + target in values or (values and target not in values and any(not v.startswith('!') for v in values)):
            unsupported = True
    if unsupported:
        continue
    selected.add(name)
    for field in ('dependencies', 'optionalDependencies', 'peerDependencies'):
        for dependency in metadata.get(field, {}):
            if field == 'peerDependencies' and metadata.get('peerDependenciesMeta', {}).get(dependency, {}).get('optional'):
                continue
            pending.append(dependency)
manifest = {
    'name': 'dsh-ohos-runtime', 'version': '0.0.1', 'private': True, 'type': 'module',
    'description': 'HarmonyOS Web and CLI production dependency closure; no desktop application.',
    'dependencies': {name: 'workspace:*' if name.startswith('@deepseek-ai/dsh') else 'workspace:~'
                     for name in sorted(selected)},
}
output = root / 'ohos/runtime/package.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Prepared {len(selected)} workspace packages for the Web/CLI runtime')

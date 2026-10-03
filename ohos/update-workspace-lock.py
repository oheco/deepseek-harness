#!/usr/bin/env python3
"""Add only OHOS workspace links without re-resolving upstream registry versions."""
import json
import os
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
lock = root / 'pnpm-lock.yaml'
text = lock.read_text()
paths = {}
for pattern in ('packages/*/*/package.json', 'apps/*/package.json', 'vendor/*/package.json',
                'native/system/packages/*/package.json'):
    for path in root.glob(pattern):
        paths[json.loads(path.read_text())['name']] = path.parent

def replace_importer(name, block):
    global text
    pattern = re.compile(r'^  ' + re.escape(name) + r':(?: \{\})?\n.*?(?=^  [^ ].*:(?: \{\})?\n|^packages:)', re.M | re.S)
    if pattern.search(text):
        text = pattern.sub(lambda _: block + '\n', text, count=1)
    else:
        text = text.replace('\npackages:\n', '\n' + block + '\npackages:\n', 1)

name = 'ohos/runtime'
manifest = json.loads((root / name / 'package.json').read_text())
lines = [f'  {name}:', '    dependencies:']
for dependency, version in manifest['dependencies'].items():
    relative = os.path.relpath(paths[dependency], root / name)
    specifier = 'link:' + relative if dependency in ('@deepseek-ai/cosmokit', '@deepseek-ai/schemastery') else version
    lines += [f"      '{dependency}':", f'        specifier: {specifier}', f'        version: link:{relative}']
replace_importer(name, '\n'.join(lines) + '\n')
replace_importer('native/system/packages/openharmony-arm64', '  native/system/packages/openharmony-arm64: {}\n')
# Reuse the existing Koffi 3.1.1 snapshot and integrity rather than resolve ^3.1.0 again.
for importer, dependency, specifier, version in [
    ('native/system/packages/entry', '@deepseek-ai/node-addon-system-openharmony-arm64', 'workspace:~', 'link:../openharmony-arm64'),
    ('packages/attachment/attachment-local', 'koffi', '^3.1.0', '3.1.1'),
]:
    pattern = re.compile(r'(^  ' + re.escape(importer) + r':\n)(.*?)(?=^  [^ ].*:(?: \{\})?\n|^packages:)', re.M | re.S)
    match = pattern.search(text)
    if not match:
        raise ValueError(f'missing importer {importer}')
    if re.search(r'^      [\'\"]?' + re.escape(dependency) + r'[\'\"]?:', match[2], re.M):
        continue
    section = 'optionalDependencies' if importer.startswith('native/') else 'dependencies'
    block = match[0].replace(f'    {section}:\n', f"    {section}:\n      '{dependency}':\n        specifier: {specifier}\n        version: {version}\n", 1)
    text = text[:match.start()] + block + text[match.end():]
lock.write_text(text)
print('Updated OHOS workspace importers; upstream registry versions and snapshots unchanged')

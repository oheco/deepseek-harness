#!/usr/bin/env python3
"""Install through oo/npm in a private prefix, accept the installed entry, and uninstall."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--oo', type=Path, required=True)
parser.add_argument('--package', required=True, help='npm registry package spec')
parser.add_argument('--tmp-parent', type=Path, required=True)
parser.add_argument('--logs', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='dsh npm package ', dir=args.tmp_parent) as tmp:
    test = Path(tmp)
    prefix = test / 'prefix with spaces'
    project = test / 'project'
    project.mkdir()
    (project / 'package.json').write_text('{"name":"ohos-dsh-acceptance","version":"1.0.0","private":true}\n')
    env = dict(os.environ, OHECO_ROOT=str(test / 'oo'), OHECO_NO_AUTO_UPDATE='1',
               OHECO_INDEX_URL=os.environ.get('OHECO_INDEX_URL', 'https://oheco.github.io/oheco-packages/index/v3/index.json'),
               npm_config_cache=str(test / 'npm-cache'), npm_config_update_notifier='false')
    def run(*command, timeout=300):
        subprocess.run(list(map(str, command)), cwd=project, env=env, check=True, timeout=timeout)
    run(args.oo, 'update')
    run(args.oo, 'npm', 'install', '--global', '--prefix', prefix, args.package)
    manifest = prefix / 'lib/node_modules/@deepseek-ai/dsh/package.json'
    metadata = json.loads(manifest.read_text())
    assert metadata['version'] == json.loads((root / 'release.json').read_text())['version'], metadata
    run(sys.executable, root / 'acceptance.py', '--dsh', prefix / 'bin/dsh', '--tmp-parent', test, '--logs', args.logs, timeout=650)
    run(args.oo, 'npm', 'uninstall', '--global', '--prefix', prefix, '@deepseek-ai/dsh')
    assert not (prefix / 'bin/dsh').exists() and not manifest.exists()
    (args.logs / 'installation.json').write_text(json.dumps({
        'package': metadata['name'], 'version': metadata['version'],
        'index': env['OHECO_INDEX_URL'], 'prefix_contains_spaces': True,
        'installed_acceptance': 'passed', 'uninstall': 'passed',
    }, indent=2) + '\n')
    print('PASS oo/npm installation in private prefix with spaces, installed acceptance, and uninstall', flush=True)

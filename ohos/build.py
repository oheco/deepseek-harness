#!/usr/bin/env python3
"""Build and deploy the fixed HarmonyOS JavaScript runtime without network access."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from native_tools import prepare, connect

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--store', type=Path, required=True, help='prepared pnpm 11 store for the source lockfile')
args = parser.parse_args()
if sys.platform != 'ohos':
    parser.error('the release build must run on HarmonyOS')
if shutil.which('binary-sign-tool') is None:
    parser.error('binary-sign-tool missing; check the LLVM tools PATH')
if (root / 'node_modules').exists():
    parser.error('use a fresh source checkout without node_modules')
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False)
packages = prepare(root, output / 'tools')
(output / 'bin').mkdir()
(output / 'tmp').mkdir()
pnpm = packages[('pnpm', '11.7.0')] / 'bin/pnpm.mjs'
launcher = output / 'bin/pnpm'
launcher.write_text('#!/usr/bin/zsh\nexec node ' + "'" + str(pnpm).replace("'", "'\\''") + "'" + ' "$@"\n')
launcher.chmod(0o755)
env = dict(os.environ, PATH=str(output / 'bin') + ':' + os.environ['PATH'],
           TMPDIR=str(output / 'tmp'), CI='true',
           pnpm_config_store_dir=str(args.store.resolve()), pnpm_config_offline='true',
           pnpm_config_script_shell='/usr/bin/zsh', pnpm_config_package_import_method='copy',
           pnpm_config_manage_package_manager_versions='false', pnpm_config_update_notifier='false')


def run(*command):
    subprocess.run(list(map(str, command)), cwd=root, env=env, check=True)


run('pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts')
connect(root, packages)
run('pnpm', 'run', 'build')
run('pnpm', '--filter', 'dsh-ohos-runtime', 'deploy', '--prod', '--offline', '--ignore-scripts',
    '--config.inject-workspace-packages=true', '--config.allow-unused-patches=true',
    '--config.node-linker=hoisted', '--config.link-workspace-packages=true', output / 'deployment')
if not (output / 'deployment/node_modules/@deepseek-ai/dsh/lib/bin.js').is_file():
    raise RuntimeError('deployment has no built dsh entry')
(output / 'native-build.json').write_text(json.dumps({
    'platform': sys.platform,
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'python': sys.version,
    'pnpm': '11.7.0',
    'tool_inputs_sha256': hashlib.sha256((root / 'tpr/ohos-build-tools/SOURCES.json').read_bytes()).hexdigest(),
    'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
}, indent=2) + '\n')
print(f'Deployed {output / "deployment"} with the native system addon.')

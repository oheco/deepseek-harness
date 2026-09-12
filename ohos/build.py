#!/usr/bin/env python3
"""Build and deploy the fixed HarmonyOS JavaScript runtime without network access."""
import argparse
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--skip-build', action='store_true', help='use previously verified lib and client build outputs')
args = parser.parse_args()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False)
env = dict(os.environ, npm_config_offline='true', npm_config_update_notifier='false')

def run(*command):
    subprocess.run(list(map(str, command)), cwd=root, env=env, check=True)

if not args.skip_build:
    run('pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts')
    run('pnpm', 'run', 'build')
run('pnpm', '--filter', 'dsh-ohos-runtime', 'deploy', '--prod', '--offline', '--ignore-scripts',
    '--config.inject-workspace-packages=true', '--config.allow-unused-patches=true',
    '--config.node-linker=hoisted', '--config.link-workspace-packages=true', output / 'deployment')
if not (output / 'deployment/node_modules/@deepseek-ai/dsh/lib/bin.js').is_file():
    raise RuntimeError('deployment has no built dsh entry; finish the build before deploying, without concurrent rebuilds')
print(f'Deployed {output / "deployment"}; build the signed HarmonyOS system addon before packaging.')

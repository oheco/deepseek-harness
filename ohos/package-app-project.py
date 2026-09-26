#!/usr/bin/env python3
"""Create a DevEco project archive for the two-step HarmonyOS launcher.

The release project uses the installed dsh command, not a checkout-specific
runtime. An explicit local launcher remains available for development. This
packager never publishes artifacts or copies personal signing material.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import zipfile

EXCLUDED = {'.git', '.hvigor', '.cxx', 'build', 'node_modules', 'oh_modules',
            '__pycache__', 'local.properties', 'oh-package-lock.json5'}
PRIVATE_SUFFIXES = {'.p12', '.p7b', '.pfx', '.keystore'}


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def copy_inputs(source, target, *, project=False):
    """Copy only regular files; reject links escaping their input tree."""
    source = source.resolve()
    for directory, dirs, files in os.walk(source):
        dirs[:] = sorted(name for name in dirs if name != '.bin' and
                         (not project or name not in EXCLUDED))
        for name in dirs:
            item = Path(directory) / name
            if item.is_symlink():
                raise ValueError(f'directory symlink is not a closed input: {item}')
        for name in sorted(files):
            item = Path(directory) / name
            if project and (name in EXCLUDED or name == '.env' or item.suffix.lower() in PRIVATE_SUFFIXES):
                raise ValueError(f'private or generated file in source template: {item}')
            if not item.resolve().is_relative_to(source):
                raise ValueError(f'file symlink escapes input tree: {item}')
            if not item.is_file():
                raise ValueError(f'not a regular file: {item}')
            destination = target / item.relative_to(source)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(item, destination)


RUN_LOG_NAME = 'dsh-0.1.7-run.log'


def runtime_defaults(home, web_launcher=None):
    """Project the installed command (or an explicit local override) and matching log path."""
    launch = 'dsh web --host 127.0.0.1 --port 0 --no-open' if web_launcher is None else f'zsh {shlex.quote(str(web_launcher))}'
    command = f'{launch} > {shlex.quote(str(Path(home) / "Documents" / RUN_LOG_NAME))} 2>&1 &'
    body = '// Generated device connection; regenerate with ohos/package-app-project.py after moving paths.\n'
    body += 'export class RuntimeDefaults {\n'
    body += f'  static homeDir: string = {json.dumps(str(home), ensure_ascii=False)};\n'
    body += f'  static runLogName: string = {json.dumps(RUN_LOG_NAME)};\n'
    body += f'  static runCommand: string = {json.dumps(command, ensure_ascii=False)};\n'
    body += '}\n'
    return body


def archive_project(stage, archive):
    folded = set()
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for path in sorted(stage.rglob('*')):
            if not path.is_file():
                continue
            name = 'DSHApp/' + path.relative_to(stage).as_posix()
            if name.casefold() in folded:
                raise ValueError(f'case-folding collision: {name}')
            folded.add(name.casefold())
            info = zipfile.ZipInfo(name, date_time=(2026, 9, 14, 0, 0, 0))
            info.create_system = 3
            with path.open('rb') as stream:
                elf = stream.read(4) == b'\x7fELF'
            executable = elf or name.endswith('/bin/dsh')
            info.external_attr = (0o100755 if executable else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with path.open('rb') as source, bundle.open(info, 'w', force_zip64=True) as target:
                shutil.copyfileobj(source, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path, help='new output directory')
    parser.add_argument('--home', type=Path, default=Path.home(),
                        help='shared user home the terminal command writes the log under')
    parser.add_argument('--web-launcher', type=Path,
                        help='development-only local launcher override; release projects use dsh on PATH')
    parser.add_argument('--checks-dir', type=Path, help='local SDK check directory holding sanitized check logs')
    parser.add_argument('--native-test-log', type=Path, help='CTest LastTest.log from the native fixture run')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    launcher = args.web_launcher.resolve() if args.web_launcher else None
    if launcher is not None and not launcher.is_file():
        parser.error('the explicit development launcher does not exist')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    stage = output / 'project'
    copy_inputs(root / 'ohos/app', stage, project=True)
    config = stage / 'entry/src/main/ets/config/RuntimeDefaults.ets'
    config.write_text(runtime_defaults(args.home, launcher))
    shutil.copyfile(root / 'LICENSE', stage / 'LICENSE')
    info = {
        'kind': 'app-project',
        'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
        'source_dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root)),
        'release_version': json.loads((root / 'ohos/release.json').read_text())['version'],
        'launch_mode': 'two-step: the terminal runs dsh; the App reads its readiness log',
        'web_launcher': str(launcher) if launcher is not None else 'installed dsh on PATH',
        'log_name': RUN_LOG_NAME,
        'development_override': launcher is not None,
    }
    (stage / 'BUILD-INFO.json').write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n')
    validation = stage / 'validation'
    validation.mkdir(exist_ok=True)
    if args.checks_dir:
        for filename in ['standalone-final.log', 'app-tests.log', 'project-tests.log', 'app-web-connection.log']:
            source_log = args.checks_dir / filename
            if source_log.is_file():
                shutil.copyfile(source_log, validation / filename)
    if args.native_test_log:
        shutil.copyfile(args.native_test_log, validation / 'native-fixtures.log')
    checks = {'previous_app': 'user confirmed the 0.1.5 App complete before migration',
              'device_acceptance': '0.1.7 App integration awaits user verification in DevEco/on device',
              'hap_build': 'not built, signed or installed by this export; configure personal signing in DevEco'}
    (stage / 'LOCAL-CHECKS.json').write_text(json.dumps(checks, indent=2) + '\n')
    archive = output / f"deepseek-harness-app-{json.loads((root / 'ohos/release.json').read_text())['version']}.zip"
    archive_project(stage, archive)
    project = {'description': 'DSH 鸿蒙 App 启动器工程（两步模式：终端启动服务，应用读取日志地址并打开）',
               'url': 'http://127.0.0.1:0/' + archive.name,
               'sha256': digest(archive), 'size': archive.stat().st_size,
               'format': 'zip', 'strip_components': 1}
    (output / 'project-artifact.json').write_text(json.dumps(project, ensure_ascii=False, indent=2) + '\n')
    (output / (archive.name + '.sha256')).write_text(f'{project["sha256"]}  {archive.name}\n')
    print(f'Local project archive: {archive} ({project["size"]} bytes)')
    print('No package was published; use export-app-local.py to export through an isolated oo index.')


if __name__ == '__main__':
    main()

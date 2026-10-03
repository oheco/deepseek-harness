#!/usr/bin/env python3
"""Create a DevEco project archive for the two-step HarmonyOS launcher.

The project uses the independent 0.2.0 local runtime, never dsh from PATH.
Export directories must be new. This packager never publishes artifacts or
reads/copies personal signing material.
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
PRIVATE_SUFFIXES = {'.p12', '.p7b', '.pfx', '.keystore', '.pem', '.key', '.cer', '.crt'}


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


RUN_LOG_NAME = 'dsh-0.2.0-run.log'
DEFAULT_WEB_LAUNCHER = Path('/storage/Users/currentUser/dev/ohos/harness-ohos-0.2.0-local/run-web.zsh')


def runtime_defaults(home, web_launcher=None):
    """Project the independent local launcher and matching Documents log path."""
    launcher = DEFAULT_WEB_LAUNCHER if web_launcher is None else web_launcher
    launch = f'zsh {shlex.quote(str(launcher))}'
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
                        help='override the independent local run-web.zsh after moving the runtime')
    parser.add_argument('--export-project', type=Path,
                        help='also create a new unsigned DevEco directory without invoking oo')
    parser.add_argument('--checks-dir', type=Path, help='local SDK check directory holding sanitized check logs')
    parser.add_argument('--native-test-log', type=Path, help='CTest LastTest.log from the native fixture run')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    launcher = args.web_launcher.resolve() if args.web_launcher else DEFAULT_WEB_LAUNCHER
    if args.web_launcher and not launcher.is_file():
        parser.error('the explicit local launcher does not exist')
    export = args.export_project.resolve() if args.export_project else None
    if export is not None and export.exists():
        parser.error('export must be a new directory; existing projects are read-only')
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
        'launch_mode': 'two-step: terminal runs the independent local package; App reads its readiness log',
        'web_launcher': str(launcher),
        'log_name': RUN_LOG_NAME,
        'local_only': True,
        'launcher_override': args.web_launcher is not None,
    }
    (stage / 'BUILD-INFO.json').write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n')
    validation = stage / 'validation'
    validation.mkdir(exist_ok=True)
    shutil.copyfile(root / 'ohos/app-migration.json', validation / 'app-migration.json')
    record = stage / 'VALIDATION.md'
    record.write_text(record.read_text().replace('](../app-migration.json)', '](validation/app-migration.json)'))
    if args.checks_dir:
        for filename in ['standalone-final.log', 'app-tests.log', 'project-tests.log', 'app-web-connection.log']:
            source_log = args.checks_dir / filename
            if source_log.is_file():
                shutil.copyfile(source_log, validation / filename)
    if args.native_test_log:
        shutil.copyfile(args.native_test_log, validation / 'native-fixtures.log')
    checks = {'version': info['release_version'],
              'source_checks': 'see VALIDATION.md and only the current-version logs under validation/',
              'device_acceptance': '0.2.0 App awaits user verification in DevEco/on device',
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
    if export is not None:
        export.mkdir(parents=True, exist_ok=False)
        copy_inputs(stage, export, project=True)
        verified = 0
        for source in stage.rglob('*'):
            if source.is_file():
                target = export / source.relative_to(stage)
                if digest(source) != digest(target):
                    raise ValueError(f'exported bytes differ: {source.relative_to(stage)}')
                verified += 1
        print(f'Unsigned DevEco project: {export}; {verified} files verified byte-for-byte')
    print('Local-only App project: no HAP build/sign/install, oo operation, publish, push or commit.')


if __name__ == '__main__':
    main()

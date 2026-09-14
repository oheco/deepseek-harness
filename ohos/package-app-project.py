#!/usr/bin/env python3
"""Create a local-only DevEco project archive for the two-step launcher.

The project carries no runtime copy: the service runs in the terminal from the
user's installed dsh, and the app only reads the address the log announces. No
registry, Release, package version, credentials, or signing profile is changed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
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


def runtime_defaults(home):
    """Writes the one device path the page needs, as a JSON string literal."""
    body = '// Generated device path; regenerate with ohos/package-app-project.py after moving the home.\n'
    body += 'export class RuntimeDefaults {\n'
    body += f'  static homeDir: string = {json.dumps(str(home), ensure_ascii=False)};\n'
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
    parser.add_argument('--checks-dir', type=Path, help='local SDK check directory holding sanitized build logs')
    parser.add_argument('--native-test-log', type=Path, help='CTest LastTest.log from the native fixture run')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    stage = output / 'project'
    copy_inputs(root / 'ohos/app', stage, project=True)
    config = stage / 'entry/src/main/ets/config/RuntimeDefaults.ets'
    config.write_text(runtime_defaults(args.home))
    shutil.copyfile(root / 'LICENSE', stage / 'LICENSE')
    info = {
        'kind': 'local-app-project', 'published': False,
        'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
        'source_dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root)),
        'launch_mode': 'two-step: the terminal runs dsh, the app reads the announced address from the log',
    }
    (stage / 'BUILD-INFO.json').write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n')
    validation = stage / 'validation'
    validation.mkdir(exist_ok=True)
    if args.checks_dir:
        for filename in ['standalone-final.log', 'resources-final.log', 'harmony-build.log']:
            shutil.copyfile(args.checks_dir / filename, validation / filename)
    if args.native_test_log:
        shutil.copyfile(args.native_test_log, validation / 'native-fixtures.log')
    checks = {'ordinary_hap_device_test': 'pending user verification',
              'complete_hap_build': 'blocked: HarmonyOS SDK configuration unavailable in the command line environment'}
    (stage / 'LOCAL-CHECKS.json').write_text(json.dumps(checks, indent=2) + '\n')
    archive = output / 'deepseek-harness-app-local.zip'
    archive_project(stage, archive)
    project = {'description': '本地 DSH 鸿蒙启动器工程（未发布，两步模式）',
               'url': 'http://127.0.0.1:0/' + archive.name,
               'sha256': digest(archive), 'size': archive.stat().st_size,
               'format': 'zip', 'strip_components': 1}
    (output / 'project-artifact.json').write_text(json.dumps(project, ensure_ascii=False, indent=2) + '\n')
    (output / (archive.name + '.sha256')).write_text(f'{project["sha256"]}  {archive.name}\n')
    print(f'Local project archive: {archive} ({project["size"]} bytes)')
    print('No package was published; use export-app-local.py to export through an isolated oo index.')


if __name__ == '__main__':
    main()

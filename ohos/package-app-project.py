#!/usr/bin/env python3
"""Create a DevEco project archive for the HarmonyOS connection manager.

Defaults use the installed, relocatable dsh entry with application-private state.
An explicit --web-launcher keeps the independent local runtime override.
Export directories must be new. This packager never builds, signs, installs or
publishes HAPs, or reads/copies personal signing material.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
from urllib.parse import urlsplit
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


def verify_broker_inputs(app):
    """Require the pinned source archive and every relocatable native payload byte."""
    cpp = app / 'entry/src/main/cpp'
    sources = json.loads((cpp / 'tpr/broker-sources.json').read_text())
    archive = cpp / 'tpr' / sources['archive']
    if archive.name != sources['archive'] or digest(archive) != sources['sha256']:
        raise ValueError('broker source archive does not match its manifest')
    native = cpp / 'tpr/broker-native-arm64'
    payload = json.loads((native / 'PAYLOAD.json').read_text())
    if payload['source_archive_sha256'] != sources['sha256']:
        raise ValueError('broker native payload uses another source archive')
    if (sources['schema_version'] != 2 or sources['local_sdk_changes'] != 'NONE' or
            payload['local_sdk_changes'] != 'NONE' or
            sources['sdk_version'] != sources['sdk_release']['version'] or
            sources['sdk_snapshot'] != 'released ' + sources['sdk_version'] or
            payload['sdk_snapshot'] != sources['sdk_snapshot'] or
            payload['source_commit'] != sources['source_commit'] or
            payload['sdk_all_files_sha256'] != sources['sdk_all_files_sha256']):
        raise ValueError('broker SDK metadata differs from the unmodified released SDK')
    companion = sources['native_dependency_manifest']
    if (Path(companion['file']).name != companion['file'] or
            digest(cpp / 'tpr' / companion['file']) != companion['sha256']):
        raise ValueError('broker dependency manifest checksum mismatch')
    sdk = cpp / 'broker_sdk'
    actual = {}
    for path in sdk.rglob('*'):
        if path.is_symlink():
            raise ValueError('broker SDK source contains a symlink')
        if path.is_file():
            actual[path.relative_to(sdk).as_posix()] = digest(path)
    if actual != sources['remote_files_sha256']:
        raise ValueError('broker SDK source differs from the released remote tree')
    if digest(cpp / 'tpr/broker-LICENSE') != sources['sdk_release']['license_sha256']:
        raise ValueError('broker SDK license checksum mismatch')
    for relative, expected in payload['files_sha256'].items():
        path = native / relative
        if not path.resolve().is_relative_to(native.resolve()) or path.is_symlink() or digest(path) != expected:
            raise ValueError('broker native payload checksum mismatch: ' + relative)
    return {'source_archive_sha256': sources['sha256'], 'native_files': len(payload['files_sha256']),
            'sdk_version': sources['sdk_version'], 'sdk_source_commit': sources['source_commit'],
            'local_sdk_changes': sources['local_sdk_changes'], 'sdk_source_files': len(actual)}


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


RUN_LOG_NAME = 'dsh-0.2.1-run.log'
DEFAULT_WEB_COMMAND = 'DSH_HOME="${XDG_CONFIG_HOME:?}/deepseek-harness" dsh web --host 127.0.0.1 --port 0 --no-open'


def runtime_defaults(home, web_launcher=None):
    """Use private state for installed dsh; preserve explicit local launcher isolation."""
    launch = DEFAULT_WEB_COMMAND if web_launcher is None else f'zsh {shlex.quote(str(web_launcher))}'
    command = f'{launch} > {shlex.quote(str(Path(home) / "Documents" / RUN_LOG_NAME))} 2>&1 &'
    body = '// Generated connection defaults; only --web-launcher selects a local runtime override.\n'
    body += 'export class RuntimeDefaults {\n'
    body += f'  static homeDir: string = {json.dumps(str(home), ensure_ascii=False)};\n'
    body += f'  static runLogName: string = {json.dumps(RUN_LOG_NAME)};\n'
    body += f'  static runCommand: string = {json.dumps(command, ensure_ascii=False)};\n'
    body += '}\n'
    return body


def artifact_url(version, archive_name, release_url=None, tag=None):
    """Append the artifact name to the specified immutable version tag."""
    expected_tag = tag if tag is not None else 'v' + version
    base = (release_url if release_url is not None else
            f'https://github.com/oheco/deepseek-harness/releases/download/{expected_tag}').rstrip('/')
    parsed = urlsplit(base)
    parts = parsed.path.split('/')
    if (parsed.scheme != 'https' or parsed.netloc != 'github.com' or
            parsed.query or parsed.fragment or len(parts) != 6 or
            not parts[1] or not parts[2] or parts[3:5] != ['releases', 'download'] or
            parts[5] != expected_tag):
        raise ValueError('--release-url must be an HTTPS GitHub release download directory for ' + expected_tag)
    return base + '/' + archive_name


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
                        help='explicit independent local run-web.zsh override instead of installed dsh')
    parser.add_argument('--release-url',
                        help='immutable HTTPS GitHub release download directory; defaults to the release version tag')
    parser.add_argument('--export-project', type=Path,
                        help='also create a new unsigned DevEco directory without invoking oo')
    parser.add_argument('--checks-dir', type=Path, help='local SDK check directory holding sanitized check logs')
    parser.add_argument('--native-test-log', type=Path, help='CTest LastTest.log from the native fixture run')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    release = json.loads((root / 'ohos/release.json').read_text())
    app_release = json.loads((root / 'ohos/app-release.json').read_text())
    archive_name = f"deepseek-harness-app-{app_release['version']}.zip"
    try:
        url = artifact_url(app_release['version'], archive_name, args.release_url, app_release['tag'])
    except ValueError as error:
        parser.error(str(error))
    launcher = args.web_launcher.resolve() if args.web_launcher is not None else None
    if launcher is not None and not launcher.is_file():
        parser.error('the explicit local launcher does not exist')
    export = args.export_project.resolve() if args.export_project else None
    if export is not None and export.exists():
        parser.error('export must be a new directory; existing projects are read-only')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    stage = output / 'project'
    broker_inputs = verify_broker_inputs(root / 'ohos/app')
    copy_inputs(root / 'ohos/app', stage, project=True)
    (stage / 'tools').mkdir(exist_ok=True)
    shutil.copyfile(root / 'ohos/prepare-broker-native.py', stage / 'tools/prepare-broker-native.py')
    config = stage / 'entry/src/main/ets/config/RuntimeDefaults.ets'
    config.write_text(runtime_defaults(args.home, launcher))
    shutil.copyfile(root / 'LICENSE', stage / 'LICENSE')
    info = {
        'kind': 'app-project',
        'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
        'source_dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root)),
        'release_version': app_release['version'],
        'runtime_release_version': release['version'],
        'upstream_version': release['upstream_version'],
        'upstream_commit': release['upstream_commit'],
        'launch_mode': 'saved local/remote connections; native broker mapping; system-trusted HTTPS/WSS',
        'broker_inputs': broker_inputs,
        'web_launcher': str(launcher) if launcher is not None else 'dsh',
        'log_name': RUN_LOG_NAME,
        'local_only': launcher is not None,
        'launcher_override': launcher is not None,
    }
    (stage / 'BUILD-INFO.json').write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n')
    validation = stage / 'validation'
    validation.mkdir(exist_ok=True)
    shutil.copyfile(root / 'ohos/app-migration.json', validation / 'app-migration.json')
    shutil.copyfile(root / 'ohos/app-release.json', validation / 'app-release.json')
    record = stage / 'VALIDATION.md'
    record.write_text(record.read_text()
                      .replace('](../app-migration.json)', '](validation/app-migration.json)')
                      .replace('](../app-release.json)', '](validation/app-release.json)'))
    if args.checks_dir:
        for filename in ['standalone-final.log', 'app-tests.log', 'project-tests.log', 'app-web-connection.log']:
            source_log = args.checks_dir / filename
            if source_log.is_file():
                shutil.copyfile(source_log, validation / filename)
    if args.native_test_log:
        shutil.copyfile(args.native_test_log, validation / 'native-fixtures.log')
    checks = {'version': info['release_version'],
              'packager_scope': 'pinned broker input validation and project export; no HAP build, signing, installation or publication by this tool',
              'source_checks': 'see VALIDATION.md and version-specific evidence under validation/',
              'device_acceptance': 'see separate installation and device receipts under validation/; this export does not perform device validation',
              'hap_build': 'see separate HAP build and signature receipts under validation/; this export does not perform a HAP build or signing'}
    (stage / 'LOCAL-CHECKS.json').write_text(json.dumps(checks, indent=2) + '\n')
    archive = output / archive_name
    archive_project(stage, archive)
    project = {'description': 'DSH 鸿蒙 App 连接管理工程（本地连接与 broker 远程连接）',
               'url': url,
               'sha256': digest(archive), 'size': archive.stat().st_size,
               'format': 'zip', 'strip_components': 1}
    (output / 'project-artifact.json').write_text(json.dumps(project, ensure_ascii=False, indent=2) + '\n')
    (output / (archive.name + '.sha256')).write_text(f'{project["sha256"]}  {archive.name}\n')
    print(f'Project archive: {archive} ({project["size"]} bytes)')
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
    mode = 'Explicit local launcher override' if launcher is not None else 'Installed dsh defaults'
    print(f'{mode}; this packager only exports: no HAP build/sign/install, oo operation, publish, push or commit.')


if __name__ == '__main__':
    main()

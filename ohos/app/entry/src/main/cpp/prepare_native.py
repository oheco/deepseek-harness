#!/usr/bin/env python3
"""Import and build the released oheco-broker C SDK entirely offline.

--sdk-from (alias --snapshot-from) accepts the released package's sdk/c directory.
The archive includes its complete source tree and package BUILDINFO.txt/LICENSE.
Existing App inputs are backed up under XDG_CACHE_HOME before replacement. Normal
rebuilds verify and extract the archive, then invoke its original build.sh; the
App payload contains six dependency archives, headers and source licenses. The
remote SDK itself is compiled from broker_sdk by the App CMake build.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile


ARCHIVES = ('libxquic-static.a', 'libjuice.a', 'libcjson.a', 'libssl.a',
            'libcrypto.a', 'libcurl.a')
PREVIOUS_INPUTS = ('broker_sdk', 'tpr/broker-sources.tar.gz',
                   'tpr/broker-sources.json', 'tpr/native-dependencies.json',
                   'tpr/broker-LICENSE', 'tpr/broker-native-arm64')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def file_records(root):
    """Hash a closed tree of regular files, rejecting links and special entries."""
    if root.is_symlink() or not root.is_dir():
        raise ValueError(f'Expected a real source directory: {root}')
    resolved = root.resolve()
    records = {}
    for directory, directories, files in os.walk(root, followlinks=False):
        for name in sorted(directories + files):
            path = Path(directory) / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not path.resolve().is_relative_to(resolved):
                raise ValueError(f'Source tree contains a link or outside input: {path}')
            if stat.S_ISREG(mode):
                records[path.relative_to(root).as_posix()] = digest(path)
            elif not stat.S_ISDIR(mode):
                raise ValueError(f'Source tree contains a special entry: {path}')
    return dict(sorted(records.items()))


def records_digest(records):
    result = hashlib.sha256()
    for name, value in sorted(records.items()):
        result.update(name.encode('utf-8') + b'\0' + bytes.fromhex(value))
    return result.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def private_path(path):
    cache = Path(os.environ['XDG_CACHE_HOME']).resolve()
    path = path.resolve()
    if not path.is_relative_to(cache) or path == cache:
        raise ValueError('Build and backup directories must be inside XDG_CACHE_HOME')
    return path


def backup_inputs(cpp, destination=None):
    existing = [name for name in PREVIOUS_INPUTS if (cpp / name).exists()]
    if not existing:
        return None
    if destination is None:
        destination = Path(tempfile.mkdtemp(prefix='dsh-broker-input-backup-',
                                          dir=os.environ['XDG_CACHE_HOME']))
    else:
        destination = private_path(destination)
        destination.mkdir(parents=True, exist_ok=False, mode=0o700)
    for name in existing:
        original, saved = cpp / name, destination / name
        saved.parent.mkdir(parents=True, exist_ok=True)
        if original.is_symlink():
            raise ValueError(f'Cannot replace a linked App input: {original}')
        if original.is_dir():
            file_records(original)
            shutil.copytree(original, saved)
        else:
            shutil.copyfile(original, saved)
    print(f'Previous App inputs saved: {destination}', flush=True)
    return destination


def publish_inputs(root, replacements, backup):
    """Replace App inputs, restoring their backups if any replacement fails."""
    changed = []
    try:
        for name, source in replacements.items():
            target = root / name
            changed.append(name)
            if target.exists():
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                shutil.copyfile(source, target)
    except BaseException as error:
        for name in reversed(changed):
            target = root / name
            saved = backup / name if backup else None
            try:
                if target.exists():
                    if target.is_dir():
                        shutil.rmtree(target)
                    else:
                        target.unlink()
                if saved is not None and saved.exists():
                    if saved.is_dir():
                        shutil.copytree(saved, target)
                    else:
                        shutil.copyfile(saved, target)
            except Exception as restore_error:
                error.add_note(f'Backup restoration failed for {name}: {restore_error}; backup: {backup}')
        raise


def snapshot(sdk, cpp, backup=None):
    if sdk.is_symlink():
        raise ValueError('SDK source directory must not be a link')
    sdk = sdk.resolve()
    if sdk.name != 'c' or sdk.parent.name != 'sdk':
        raise ValueError('--sdk-from must identify the released package sdk/c directory')
    package = sdk.parent.parent
    buildinfo, license_file = package / 'BUILDINFO.txt', package / 'LICENSE'
    for path in (buildinfo, license_file):
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(package):
            raise ValueError(f'Released package input is not a regular local file: {path}')
    release = dict(line.split('=', 1) for line in buildinfo.read_text().splitlines()
                   if '=' in line)
    version = release.get('version', '')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?', version) or release.get('platform') != 'ohos-arm64':
        raise ValueError('Expected a released ohos-arm64 SDK package with version in BUILDINFO.txt')
    commit = release.get('source_commit', '')
    if len(commit) != 40 or any(character not in '0123456789abcdef' for character in commit):
        raise ValueError('Released SDK BUILDINFO.txt has no valid source_commit')
    sdk_records = file_records(sdk)
    for required in ('build.sh', 'CMakeLists.txt', 'tpr/native-dependencies.json',
                     'remote/CMakeLists.txt', 'build/common.sh'):
        if required not in sdk_records:
            raise ValueError(f'Released SDK is incomplete: {required}')
    inputs = {'source/sdk/c/' + name: sdk / name for name in sdk_records}
    inputs.update({'source/BUILDINFO.txt': buildinfo, 'source/LICENSE': license_file})
    records = {name: digest(path) for name, path in sorted(inputs.items())}
    backup = backup_inputs(cpp, backup)
    tpr = cpp / 'tpr'
    tpr.mkdir(exist_ok=True)
    # All package bytes are retained; tar ownership, modes and gzip time are fixed.
    with tempfile.TemporaryDirectory(prefix='dsh-sdk-import-', dir=os.environ['TMPDIR']) as temporary:
        stage = Path(temporary)
        archive = stage / 'broker-sources.tar.gz'
        with archive.open('xb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0, filename='') as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as tar:
                for name, path in sorted(inputs.items()):
                    if digest(path) != records[name]:
                        raise ValueError(f'SDK source changed during snapshot: {path}')
                    info = tarfile.TarInfo(name)
                    info.size = path.stat().st_size
                    info.uid = info.gid = info.mtime = 0
                    info.uname = info.gname = ''
                    info.mode = 0o644
                    with path.open('rb') as stream:
                        tar.addfile(info, stream)
        if file_records(sdk) != sdk_records or digest(buildinfo) != records['source/BUILDINFO.txt']:
            raise ValueError('Installed SDK changed during snapshot')
        remote_records = file_records(sdk / 'remote')
        metadata = {
            'schema_version': 2, 'archive': archive.name, 'sha256': digest(archive),
            'sdk_origin': 'https://github.com/oheco/oheco-broker',
            'sdk_snapshot': f'released {version}', 'sdk_version': version,
            'source_commit': commit, 'sdk_release': {
                'version': release['version'], 'platform': release['platform'],
                'source_package_dir': str(package), 'source_sdk_dir': str(sdk),
                'buildinfo_file': 'source/BUILDINFO.txt',
                'buildinfo_sha256': records['source/BUILDINFO.txt'],
                'license_sha256': records['source/LICENSE'],
            },
            'sdk_file_count': len(sdk_records),
            'sdk_all_files_sha256': records_digest(sdk_records),
            'native_dependency_manifest': {
                'file': 'native-dependencies.json',
                'sha256': sdk_records['tpr/native-dependencies.json'],
            },
            'files_sha256': records, 'remote_files_sha256': remote_records,
            'local_sdk_changes': 'NONE',
        }
        shutil.copytree(sdk / 'remote', stage / 'broker_sdk')
        if file_records(stage / 'broker_sdk') != remote_records:
            raise ValueError('SDK remote copy differs from released inputs')
        shutil.copyfile(license_file, stage / 'broker-LICENSE')
        shutil.copyfile(sdk / 'tpr/native-dependencies.json', stage / 'native-dependencies.json')
        write_json(stage / 'broker-sources.json', metadata)
        publish_inputs(cpp, {
            'tpr/broker-sources.tar.gz': archive,
            'tpr/broker-LICENSE': stage / 'broker-LICENSE',
            'tpr/native-dependencies.json': stage / 'native-dependencies.json',
            'broker_sdk': stage / 'broker_sdk',
            'tpr/broker-sources.json': stage / 'broker-sources.json',
        }, backup)
    print(f'Imported released SDK {release["version"]}: {len(sdk_records)} files, '
          f'{len(remote_records)} remote files; local SDK changes: NONE', flush=True)
    print(f'SDK source archive SHA256: {metadata["sha256"]}', flush=True)


def prepare(cpp, build):
    tpr = cpp / 'tpr'
    metadata = json.loads((tpr / 'broker-sources.json').read_text())
    if metadata.get('schema_version') != 2 or metadata.get('local_sdk_changes') != 'NONE':
        raise ValueError('Import the released SDK with --sdk-from before rebuilding')
    archive = tpr / metadata['archive']
    companion = metadata['native_dependency_manifest']
    if digest(tpr / companion['file']) != companion['sha256'] or digest(archive) != metadata['sha256']:
        raise ValueError('SDK source archive or dependency manifest checksum mismatch')
    if file_records(cpp / 'broker_sdk') != metadata['remote_files_sha256']:
        raise ValueError('App SDK source differs from the released remote tree')
    build.mkdir(parents=True, exist_ok=False, mode=0o700)
    expected = metadata['files_sha256']
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)) or set(names) != set(expected):
            raise ValueError('SDK archive does not contain exactly the recorded files')
        for member in members:
            name = PurePosixPath(member.name)
            if not member.isfile() or name.is_absolute() or '..' in name.parts or name.parts[0] != 'source':
                raise ValueError('SDK archive contains a link, special entry or outside path')
        tar.extractall(build, filter='data')
    actual = {'source/' + name: value for name, value in file_records(build / 'source').items()}
    if actual != expected:
        raise ValueError('SDK source file digests differ after extraction')
    sdk = build / 'source/sdk/c'
    sdk_records = {name.removeprefix('source/sdk/c/'): value for name, value in expected.items()
                   if name.startswith('source/sdk/c/')}
    installed_sdk = Path(metadata['sdk_release']['source_sdk_dir'])
    installed_before = file_records(installed_sdk) if installed_sdk.is_dir() else None
    if installed_before is not None and installed_before != sdk_records:
        raise ValueError('Installed SDK bytes differ from the archived package inputs')
    command = ['sh', str(sdk / 'build.sh'), '--build-dir', str(build / 'official-build')]
    env = {name: value for name, value in os.environ.items()
           if not any(word in name.upper() for word in ('KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'CREDENTIAL'))}
    env.update(NATIVE_BUILD_DIR=str(build / 'native'), NATIVE_PREFIX=str(build / 'native/prefix'),
               CURL_BUILD_DIR=str(build / 'curl'), OB_REMOTE_BUILD_DIR=str(build / 'remote'),
               OB_NATIVE_PREFIX=str(build / 'native/prefix'), OB_CURL_PREFIX=str(build / 'curl/prefix'),
               OB_CXX_RUNTIME='c++', NATIVE_JOBS=os.environ.get('NATIVE_JOBS', '4'),
               PYTHONDONTWRITEBYTECODE='1')
    print('Building the original SDK offline: ' + ' '.join(command), flush=True)
    subprocess.run(command, env=env, check=True)
    if file_records(sdk) != sdk_records:
        raise ValueError('Official SDK build modified the extracted source tree')
    if installed_before is not None and file_records(installed_sdk) != installed_before:
        raise ValueError('Installed SDK changed during the offline build')
    with tempfile.TemporaryDirectory(prefix='dsh-sdk-payload-', dir=os.environ['TMPDIR']) as temporary:
        output = Path(temporary) / 'broker-native-arm64'
        (output / 'include').mkdir(parents=True)
        (output / 'lib').mkdir()
        for prefix in (build / 'native/prefix', build / 'curl/prefix'):
            file_records(prefix / 'include')
            shutil.copytree(prefix / 'include', output / 'include', dirs_exist_ok=True)
        for name in ARCHIVES:
            prefix = build / ('curl/prefix' if name == 'libcurl.a' else 'native/prefix')
            shutil.copyfile(prefix / 'lib' / name, output / 'lib' / name)
        licenses = output / 'licenses'
        licenses.mkdir()
        shutil.copyfile(build / 'source/LICENSE', licenses / 'broker-LICENSE')
        for dependency in ('boringssl', 'xquic', 'libjuice', 'cjson', 'curl'):
            name = 'COPYING' if dependency == 'curl' else 'LICENSE'
            shutil.copyfile(sdk / 'tpr' / dependency / name, licenses / (dependency + '-LICENSE'))
        probes = json.loads((build / 'curl/curl-native-probes.json').read_text())
        probes['tls_libraries'] = ['lib/libssl.a', 'lib/libcrypto.a']
        write_json(output / 'native-probes.json', probes)
        artifacts = file_records(output)
        (output / 'SHA256SUMS').write_text(''.join(value + '  ' + name + '\n' for name, value in sorted(artifacts.items())))
        write_json(output / 'PAYLOAD.json', {
            'platform': 'arm64 HarmonyOS', 'sdk_snapshot': metadata['sdk_snapshot'],
            'source_commit': metadata['source_commit'], 'local_sdk_changes': 'NONE',
            'source_archive_sha256': metadata['sha256'],
            'sdk_all_files_sha256': metadata['sdk_all_files_sha256'],
            'build': 'original released SDK build.sh; offline; signed SDK feature probes',
            'files_sha256': artifacts,
            'remote_sdk': 'compiled from broker_sdk by App CMake; no prebuilt libob_remote.a in payload',
            'rebuild': 'python3 entry/src/main/cpp/prepare_native.py --build-dir "$XDG_CACHE_HOME/<new-directory>"',
        })
        target = tpr / 'broker-native-arm64'
        backup = build / 'previous-native-payload'
        if target.exists():
            file_records(target)
            shutil.copytree(target, backup / 'broker-native-arm64')
        publish_inputs(tpr, {'broker-native-arm64': output}, backup)
    write_json(build / 'sdk-intake.json', {
        'sdk_version': metadata['sdk_version'], 'source_commit': metadata['source_commit'],
        'installed_sdk_dir': metadata['sdk_release']['source_sdk_dir'],
        'buildinfo_sha256': metadata['sdk_release']['buildinfo_sha256'],
        'sdk_file_count': metadata['sdk_file_count'],
        'sdk_all_files_sha256': metadata['sdk_all_files_sha256'],
        'source_archive_sha256': metadata['sha256'],
        'remote_file_count': len(metadata['remote_files_sha256']),
        'remote_files_sha256': metadata['remote_files_sha256'],
        'local_sdk_changes': 'NONE',
        'installed_sdk_unchanged': True if installed_before is not None else None,
        'installed_sdk_before_sha256': records_digest(installed_before) if installed_before is not None else None,
        'installed_sdk_after_sha256': records_digest(installed_before) if installed_before is not None else None,
        'official_build_command': command,
        'official_build_exit_code': 0,
        'signed_probes': 'only those invoked by the original SDK build.sh',
        'extra_tests_run': False, 'dependency_archives': list(ARCHIVES),
        'payload_files_sha256': artifacts,
    })
    print(f'Prepared relocatable formal SDK dependency payload: {target}', flush=True)
    print(f'Official SDK build records retained: {build}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk-from', '--snapshot-from', dest='sdk_from', type=Path,
                        help='released oheco-broker package sdk/c directory')
    parser.add_argument('--cpp', type=Path, help='explicit exported native source directory')
    parser.add_argument('--build-dir', type=Path, help='new private XDG_CACHE_HOME build directory')
    parser.add_argument('--backup-dir', type=Path, help='new private directory for previous App inputs')
    parser.add_argument('--snapshot-only', action='store_true')
    args = parser.parse_args()
    cpp = args.cpp.resolve() if args.cpp else Path(__file__).resolve().parent
    if args.sdk_from:
        snapshot(args.sdk_from, cpp, args.backup_dir)
    elif args.backup_dir:
        parser.error('--backup-dir requires --sdk-from')
    if args.snapshot_only:
        if not args.sdk_from:
            parser.error('--snapshot-only requires --sdk-from')
        return
    cache = Path(os.environ['XDG_CACHE_HOME']).resolve()
    build = private_path(args.build_dir if args.build_dir else cache / 'dsh-broker-native')
    for tool in ('clang', 'clang++', 'cmake', 'ninja', 'binary-sign-tool'):
        if not shutil.which(tool):
            parser.error(f'{tool} missing; check SDK LLVM/toolchains PATH')
    prepare(cpp, build)


if __name__ == '__main__':
    main()

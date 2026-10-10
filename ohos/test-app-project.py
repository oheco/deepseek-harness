#!/usr/bin/env python3
"""Keyless tests for formal App project exports and explicit local launcher overrides."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
import struct
import zipfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('app_packaging', ROOT / 'ohos/package-app-project.py')
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='dsh-app-project-test-', dir=os.environ['TMPDIR'])
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_app_identity_and_sdk_match_the_requested_package(self):
        app = ROOT / 'ohos/app'
        metadata = json.loads((app / 'AppScope/app.json5').read_text())['app']
        self.assertEqual(metadata['bundleName'], 'org.oheco.' + 'deepseek-harness'.replace('-', ''))
        release = json.loads((ROOT / 'ohos/release.json').read_text())
        app_release = json.loads((ROOT / 'ohos/app-release.json').read_text())
        self.assertEqual(metadata['versionName'], app_release['version'])
        self.assertEqual(metadata['versionCode'], app_release['version_code'])
        self.assertRegex(release['version'], r'^\d+\.\d+\.\d+-rc\.[1-9]\d*-ohos\.[1-9]\d*$')
        self.assertEqual(release['version'], release['upstream_version'] + '-ohos.1')
        self.assertEqual(release['upstream_version'], '0.2.0-rc.2')
        upstream = subprocess.check_output(['git', 'rev-parse',
            'dsh-v' + release['upstream_version'] + '^{commit}'], cwd=ROOT, text=True).strip()
        self.assertEqual(release['upstream_commit'], upstream)
        self.assertGreater(metadata['versionCode'], 1000002)
        names = json.loads((app / 'AppScope/resources/base/element/string.json').read_text())['string']
        self.assertEqual(next(item['value'] for item in names if item['name'] == 'app_name'), 'Deepseek Harness')
        product = json.loads((app / 'build-profile.json5').read_text())['app']['products'][0]
        for name in ['compileSdkVersion', 'targetSdkVersion', 'compatibleSdkVersion']:
            self.assertEqual(product[name], '6.1.0(23)')

    def test_app_icons_follow_the_layered_icon_specification(self):
        app = ROOT / 'ohos/app'
        media = app / 'AppScope/resources/base/media'
        description = json.loads((media / 'layered_image.json').read_text())
        self.assertEqual(description, {'layered-image': {
            'background': '$media:background',
            'foreground': '$media:foreground',
        }}, 'the layered icon must reference both layers')
        for name, size, wants_alpha in [('background.png', 1024, None), ('foreground.png', 1024, True)]:
            header = (media / name).read_bytes()[:26]
            self.assertEqual(header[:8], b'\x89PNG\r\n\x1a\n', f'{name} must be a PNG')
            self.assertEqual(struct.unpack('>II', header[16:24]), (size, size))
            if wants_alpha is not None:
                # The background may still carry a fully opaque alpha channel; its
                # coverage is checked where the raster is produced.
                self.assertEqual(header[25] in (4, 6), wants_alpha, f'{name} alpha channel')
        # The system draws the rounded tile, so no raster may carry its own cut corners.
        self.assertTrue((media / 'app_icon.png').is_file(), 'keep the flat fallback tile')
        self.assertFalse((media / 'app_icon.svg').exists(),
                         'an SVG beside the PNG would collide on the resource name')

    def test_manifests_reference_the_layered_icon(self):
        app = ROOT / 'ohos/app'
        application = json.loads((app / 'AppScope/app.json5').read_text())['app']
        ability = json.loads((app / 'entry/src/main/module.json5').read_text())['module']['abilities'][0]
        self.assertEqual(application['icon'], '$media:layered_image')
        self.assertEqual(ability['icon'], '$media:layered_image',
                         'the launcher entry and the window decoration share this icon')
        self.assertEqual(ability['startWindowIcon'], '$media:ability_icon')
        dark = app / 'entry/src/main/resources/dark/media/ability_icon.png'
        self.assertTrue(dark.is_file(), 'a dark title bar needs its own start-window icon')

    def test_copy_omits_build_trees_and_refuses_credentials(self):
        source = self.root / 'source'
        (source / 'entry/build').mkdir(parents=True)
        (source / 'entry/main.ets').write_text('source')
        (source / 'entry/build/old.hap').write_text('not source')
        packaging.copy_inputs(source, self.root / 'copy', project=True)
        self.assertTrue((self.root / 'copy/entry/main.ets').is_file())
        self.assertFalse((self.root / 'copy/entry/build').exists())
        (source / 'personal.p12').write_text('private fixture')
        with self.assertRaisesRegex(ValueError, 'private'):
            packaging.copy_inputs(source, self.root / 'rejected', project=True)

    def test_copy_rejects_escaping_file_and_directory_links(self):
        source = self.root / 'source'
        source.mkdir()
        outside = self.root / 'outside'
        outside.write_text('outside')
        (source / 'link').symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'escapes'):
            packaging.copy_inputs(source, self.root / 'rejected')
        (source / 'link').unlink()
        (source / 'dir').symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'directory symlink'):
            packaging.copy_inputs(source, self.root / 'rejected')

    def test_zip_records_executable_bytes_and_stable_root(self):
        stage = self.root / 'project'
        (stage / 'bin').mkdir(parents=True)
        (stage / 'bin/dsh').write_text('#!/usr/bin/zsh\n')
        (stage / 'addon.node').write_bytes(b'\x7fELFfixture')
        (stage / 'README.md').write_text('local fixture')
        first, second = self.root / 'a.zip', self.root / 'b.zip'
        packaging.archive_project(stage, first)
        packaging.archive_project(stage, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with zipfile.ZipFile(first) as archive:
            self.assertEqual(archive.getinfo('DSHApp/bin/dsh').external_attr >> 16, 0o100755)
            self.assertEqual(archive.getinfo('DSHApp/addon.node').external_attr >> 16, 0o100755)
            self.assertEqual(archive.getinfo('DSHApp/README.md').external_attr >> 16, 0o100644)

    def test_case_conflicts_rejected_on_private_filesystem(self):
        stage = self.root / 'project'
        stage.mkdir()
        (stage / 'File').write_text('a')
        (stage / 'file').write_text('b')
        with self.assertRaisesRegex(ValueError, 'case-folding'):
            packaging.archive_project(stage, self.root / 'conflict.zip')

    def test_generated_home_is_a_string_literal_not_a_shell_command(self):
        value = '/path with spaces/"quoted"/$not-a-shell\nnext'
        content = packaging.runtime_defaults(value)
        self.assertEqual(content.count(json.dumps(value)), 1)
        self.assertIn('static homeDir: string', content)
        self.assertNotIn('$not-a-shell\nnext', content)

    def test_generated_command_quotes_paths_and_uses_the_new_log(self):
        home = self.root / "home with spaces '$(literal)`command`"
        launcher = self.root / "launcher 'quoted' $(literal)`command`.zsh"
        content = packaging.runtime_defaults(home, launcher)
        literal = re.search(r'static runCommand: string = (.+);', content)[1]
        command = json.loads(literal)
        self.assertEqual(shlex.split(command), ['zsh', str(launcher), '>',
            str(home / 'Documents/dsh-0.2.0-run.log'), '2>&1', '&'])
        self.assertNotIn('dsh web', command)
        self.assertNotIn('--port 9000', command)

    def test_page_uses_the_exported_connection_settings(self):
        page = (ROOT / 'ohos/app/entry/src/main/ets/pages/ConnectionHome.ets').read_text()
        self.assertNotIn('importLog', page)
        self.assertNotIn('RuntimeDefaults.runCommand', page)
        self.assertNotIn('broker.oheco.org', page)
        self.assertIn("private serviceUrl: string = '';", page)
        self.assertIn('Navigation(this.paths)', page)
        self.assertIn('NavDestination()', page)
        self.assertNotIn('dsh web --host', page)
        defaults = (ROOT / 'ohos/app/entry/src/main/ets/config/RuntimeDefaults.ets').read_text()
        self.assertIn('dsh-0.2.0-run.log', defaults)
        home = json.loads(re.search(r'static homeDir: string = (.+);', defaults)[1])
        self.assertEqual(defaults, packaging.runtime_defaults(home))
        self.assertIn('dsh web --host 127.0.0.1 --port 0 --no-open', defaults)
        self.assertNotIn('run-web.zsh', defaults)
        self.assertNotIn('0.1.7', defaults)

    def test_default_command_uses_installed_dsh_with_private_command_state(self):
        home = self.root / "home with spaces '$(literal)`command`"
        content = packaging.runtime_defaults(home)
        command = json.loads(re.search(r'static runCommand: string = (.+);', content)[1])
        self.assertEqual(shlex.split(command), ['DSH_HOME=${XDG_CONFIG_HOME:?}/deepseek-harness',
            'dsh', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open',
            '>', str(home / 'Documents/dsh-0.2.0-run.log'), '2>&1', '&'])
        self.assertTrue(command.startswith('DSH_HOME="${XDG_CONFIG_HOME:?}/deepseek-harness" dsh web '))
        self.assertNotIn('export ', command)
        self.assertNotIn('chmod', command)
        self.assertNotIn('run-web.zsh', command)
        self.assertNotIn('0.1.7', command)

    def test_default_command_resolves_relocated_entry_without_changing_parent_environment(self):
        home = self.root / "home '$(literal)`command`"
        (home / 'Documents').mkdir(parents=True)
        entry = self.root / 'relocated package/bin/dsh'
        entry.parent.mkdir(parents=True)
        entry.write_text('#!/usr/bin/zsh -f\nprint -r -- "$DSH_HOME"\n'
                         'printf "%s\\n" "$@"\n')
        entry.chmod(0o700)
        config = self.root / "private config '$(literal)`command`"
        env = {'PATH': str(entry.parent) + ':' + os.environ['PATH'],
               'DSH_HOME': 'inherited-profile-state', 'XDG_CONFIG_HOME': str(config)}
        command = json.loads(re.search(r'static runCommand: string = (.+);', packaging.runtime_defaults(home))[1])
        result = subprocess.run(['zsh', '-f', '-c', command + '\nwait\nprint -r -- "$DSH_HOME"'],
                                env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(result.stdout.strip(), 'inherited-profile-state')
        self.assertEqual((home / 'Documents' / packaging.RUN_LOG_NAME).read_text().splitlines(),
                         [str(config / 'deepseek-harness'), 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'])

    def test_default_command_requires_a_private_config_directory(self):
        home = self.root / 'home'
        (home / 'Documents').mkdir(parents=True)
        command = json.loads(re.search(r'static runCommand: string = (.+);', packaging.runtime_defaults(home))[1])
        result = subprocess.run(['zsh', '-f', '-c', command.removesuffix(' &')],
                                env={'PATH': os.environ['PATH']}, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertNotEqual(result.returncode, 0)
        diagnostic = result.stdout + (home / 'Documents' / packaging.RUN_LOG_NAME).read_text()
        self.assertIn('XDG_CONFIG_HOME', diagnostic)
        self.assertIn('parameter', diagnostic)

    def test_artifact_urls_use_the_matching_immutable_release(self):
        version = json.loads((ROOT / 'ohos/release.json').read_text())['version']
        name = 'deepseek-harness-app-' + version + '.zip'
        base = 'https://github.com/oheco/deepseek-harness/releases/download/v' + version
        self.assertEqual(packaging.artifact_url(version, name), base + '/' + name)
        self.assertEqual(packaging.artifact_url(version, name, base + '/'), base + '/' + name)
        for invalid in ['http://127.0.0.1:0', base.replace('https:', 'http:'),
                        'https://github.com/oheco/deepseek-harness/releases/latest/download',
                        base.replace('/v' + version, '/v' + version + '-mismatch'),
                        base + '?token=fixture', base + '#fragment']:
            with self.subTest(url=invalid), self.assertRaisesRegex(ValueError, 'release download directory'):
                packaging.artifact_url(version, name, invalid)

    def test_broker_input_validation_rejects_changed_sdk_archive_native_and_license_bytes(self):
        app = self.root / 'app'
        cpp = app / 'entry/src/main/cpp'
        sdk_file = cpp / 'broker_sdk/remote.c'
        sdk_file.parent.mkdir(parents=True)
        sdk_file.write_bytes(b'released SDK source')
        native_file = cpp / 'tpr/broker-native-arm64/lib/fixture.a'
        native_file.parent.mkdir(parents=True)
        native_file.write_bytes(b'pinned native bytes; never executed')
        archive = cpp / 'tpr/broker-sources.tar.gz'
        archive.write_bytes(b'pinned source archive bytes')
        license_file = cpp / 'tpr/broker-LICENSE'
        license_file.write_bytes(b'released license')
        dependency = cpp / 'tpr/native-dependencies.json'
        dependency.write_text('{}\n')
        sources = {'schema_version': 2, 'archive': archive.name, 'sha256': packaging.digest(archive),
                   'sdk_version': '0.4.0', 'sdk_snapshot': 'released 0.4.0',
                   'sdk_release': {'version': '0.4.0', 'license_sha256': packaging.digest(license_file)},
                   'source_commit': 'a' * 40, 'sdk_all_files_sha256': 'b' * 64,
                   'local_sdk_changes': 'NONE',
                   'remote_files_sha256': {'remote.c': packaging.digest(sdk_file)},
                   'native_dependency_manifest': {'file': dependency.name, 'sha256': packaging.digest(dependency)}}
        payload = {'source_archive_sha256': sources['sha256'], 'sdk_snapshot': sources['sdk_snapshot'],
                   'source_commit': sources['source_commit'], 'local_sdk_changes': 'NONE',
                   'sdk_all_files_sha256': sources['sdk_all_files_sha256'],
                   'files_sha256': {'lib/fixture.a': packaging.digest(native_file)}}
        manifest = cpp / 'tpr/broker-sources.json'
        manifest.write_text(json.dumps(sources))
        payload_file = cpp / 'tpr/broker-native-arm64/PAYLOAD.json'
        payload_file.write_text(json.dumps(payload))
        verified = packaging.verify_broker_inputs(app)
        self.assertEqual(verified['sdk_version'], '0.4.0')
        self.assertEqual(verified['local_sdk_changes'], 'NONE')
        for path, error in [(archive, 'source archive'), (sdk_file, 'SDK source'),
                            (license_file, 'license checksum'), (native_file, 'payload checksum'),
                            (dependency, 'dependency manifest checksum')]:
            with self.subTest(input=path.name):
                original = path.read_bytes()
                path.write_bytes(original + b'changed')
                with self.assertRaisesRegex(ValueError, error):
                    packaging.verify_broker_inputs(app)
                path.write_bytes(original)
        for record, path, key, value in [(sources, manifest, 'local_sdk_changes', 'changed'),
                                         (payload, payload_file, 'source_commit', 'c' * 40)]:
            with self.subTest(metadata=key):
                original = record[key]
                record[key] = value
                path.write_text(json.dumps(record))
                with self.assertRaisesRegex(ValueError, 'SDK metadata'):
                    packaging.verify_broker_inputs(app)
                record[key] = original
                path.write_text(json.dumps(record))
        payload['files_sha256']['../outside'] = 'd' * 64
        payload_file.write_text(json.dumps(payload))
        with self.assertRaisesRegex(ValueError, 'payload checksum'):
            packaging.verify_broker_inputs(app)

    def test_manual_connections_use_only_internet_permission(self):
        app = ROOT / 'ohos/app'
        module = json.loads((app / 'entry/src/main/module.json5').read_text())['module']
        self.assertEqual({item['name'] for item in module['requestPermissions']},
                         {'ohos.permission.INTERNET'})
        self.assertEqual(module['deviceTypes'], ['phone', 'tablet', '2in1'])
        page = (app / 'entry/src/main/ets/pages/ConnectionHome.ets').read_text()
        self.assertNotIn('requestPermissionsFromUser', page)
        self.assertNotIn('picker.DocumentViewPicker', page)
        self.assertNotIn('pickCertificate', page)
        self.assertNotIn('READ_WRITE_USER_FILE', page)
        self.assertIn('native.brokerLogin', page)
        self.assertIn('native.brokerConnect', page)
        self.assertIn('native.dshProbe', page)
        actions = (app / 'entry/src/main/ets/launcher/PathActions.ets').read_text()
        self.assertNotIn('fs.open', actions)
        self.assertNotIn('fs.copy', actions)
        self.assertNotIn('openEditor', actions)

    def test_template_has_no_personal_signing_or_generated_inputs(self):
        app = ROOT / 'ohos/app'
        profile = json.loads((app / 'build-profile.json5').read_text())
        self.assertEqual(profile['app']['signingConfigs'], [])
        for path in app.rglob('*'):
            self.assertFalse(path.is_symlink(), str(path))
            self.assertFalse(set(path.relative_to(app).parts) & packaging.EXCLUDED, str(path))
            self.assertNotIn(path.suffix.lower(), packaging.PRIVATE_SUFFIXES, str(path))

    def test_packaging_exports_new_directory_and_refuses_existing_output(self):
        output, export = self.root / 'archive', self.root / 'DSHApp-0.2.0'
        result = subprocess.run(['python3', '-B', str(ROOT / 'ohos/package-app-project.py'),
                                 '--output', str(output), '--export-project', str(export)],
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(result.returncode, 0, result.stdout)
        info = json.loads((export / 'BUILD-INFO.json').read_text())
        release = json.loads((ROOT / 'ohos/release.json').read_text())
        app_release = json.loads((ROOT / 'ohos/app-release.json').read_text())
        self.assertEqual(info['release_version'], app_release['version'])
        self.assertEqual(info['runtime_release_version'], release['version'])
        self.assertEqual(info['upstream_version'], release['upstream_version'])
        self.assertEqual(info['upstream_commit'], release['upstream_commit'])
        self.assertRegex(info['source_commit'], r'^[0-9a-f]{40}$')
        self.assertIsInstance(info['source_dirty'], bool)
        self.assertFalse(info['local_only'])
        self.assertFalse(info['launcher_override'])
        self.assertEqual(info['web_launcher'], 'dsh')
        self.assertIn('system-trusted HTTPS/WSS', info['launch_mode'])
        self.assertEqual(info['broker_inputs']['sdk_version'], '0.5.0')
        self.assertEqual(info['broker_inputs']['local_sdk_changes'], 'NONE')
        self.assertEqual(info['broker_inputs']['sdk_source_files'], 26)
        self.assertEqual((export / 'entry/src/main/ets/config/RuntimeDefaults.ets').read_text(),
                         packaging.runtime_defaults(Path.home()))
        self.assertEqual((export / 'LICENSE').read_bytes(), (ROOT / 'LICENSE').read_bytes())
        self.assertEqual((export / 'entry/src/main/cpp/tpr/broker-LICENSE').read_bytes(),
                         (ROOT / 'ohos/app/entry/src/main/cpp/tpr/broker-LICENSE').read_bytes())
        self.assertEqual(json.loads((export / 'build-profile.json5').read_text())['app']['signingConfigs'], [])
        self.assertEqual((export / 'validation/app-migration.json').read_bytes(),
                         (ROOT / 'ohos/app-migration.json').read_bytes())
        documentation = (export / 'VALIDATION.md').read_text()
        self.assertIn('](validation/app-migration.json)', documentation)
        self.assertNotIn('](../app-migration.json)', documentation)
        checks = json.loads((export / 'LOCAL-CHECKS.json').read_text())
        self.assertEqual(checks['version'], app_release['version'])
        self.assertIn('by this tool', checks['packager_scope'])
        self.assertIn('separate HAP build and signature receipts', checks['hap_build'])
        self.assertIn('separate installation and device receipts', checks['device_acceptance'])
        self.assertNotIn('awaits user verification', checks['device_acceptance'])
        archive = output / ('deepseek-harness-app-' + info['release_version'] + '.zip')
        artifact = json.loads((output / 'project-artifact.json').read_text())
        self.assertEqual(artifact['url'], 'https://github.com/oheco/deepseek-harness/releases/download/' +
                         app_release['tag'] + '/' + archive.name)
        self.assertEqual(artifact['sha256'], packaging.digest(archive))
        self.assertEqual(artifact['size'], archive.stat().st_size)
        self.assertEqual((output / (archive.name + '.sha256')).read_text(),
                         artifact['sha256'] + '  ' + archive.name + '\n')
        with zipfile.ZipFile(archive) as bundle:
            for item in bundle.infolist():
                self.assertEqual(bundle.read(item), (export / Path(item.filename).relative_to('DSHApp')).read_bytes())
        marker = export / 'user-edit.txt'
        marker.write_text('preserved')
        refused = subprocess.run(['python3', '-B', str(ROOT / 'ohos/package-app-project.py'),
                                  '--output', str(self.root / 'again'), '--export-project', str(export)],
                                 text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('existing projects are read-only', refused.stdout)
        self.assertEqual(marker.read_text(), 'preserved')

    def test_explicit_launcher_export_keeps_local_override_metadata_and_quoted_paths(self):
        launcher = self.root / "local launcher '$(literal)`command`.zsh"
        launcher.write_text('#!/usr/bin/zsh\n# existing isolated local launcher\n')
        home = self.root / "home '$(literal)`command`"
        profile = home / '.dsh/saved-profile.json'
        profile.parent.mkdir(parents=True)
        profile.write_text('existing user profile')
        original_launcher = launcher.read_bytes()
        output = self.root / 'local-archive'
        release = json.loads((ROOT / 'ohos/release.json').read_text())
        app_release = json.loads((ROOT / 'ohos/app-release.json').read_text())
        base = 'https://github.com/oheco/deepseek-harness/releases/download/' + app_release['tag']
        result = subprocess.run(['python3', '-B', str(ROOT / 'ohos/package-app-project.py'),
                                 '--output', str(output), '--web-launcher', str(launcher),
                                 '--home', str(home), '--release-url', base + '/'],
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(result.returncode, 0, result.stdout)
        stage = output / 'project'
        info = json.loads((stage / 'BUILD-INFO.json').read_text())
        self.assertTrue(info['local_only'])
        self.assertTrue(info['launcher_override'])
        self.assertEqual(info['web_launcher'], str(launcher.resolve()))
        self.assertEqual((stage / 'entry/src/main/ets/config/RuntimeDefaults.ets').read_text(),
                         packaging.runtime_defaults(home, launcher.resolve()))
        artifact = json.loads((output / 'project-artifact.json').read_text())
        self.assertEqual(artifact['url'], base + '/deepseek-harness-app-' + app_release['version'] + '.zip')
        self.assertEqual(launcher.read_bytes(), original_launcher)
        self.assertEqual(profile.read_text(), 'existing user profile')

    def test_invalid_release_url_and_missing_explicit_launcher_create_no_output(self):
        for option in [['--release-url', 'http://127.0.0.1:0'],
                       ['--web-launcher', str(self.root / 'missing.zsh')]]:
            output = self.root / 'rejected-archive'
            result = subprocess.run(['python3', '-B', str(ROOT / 'ohos/package-app-project.py'),
                                     '--output', str(output), *option],
                                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())

    def test_export_sync_never_opens_signing_identity_or_runtime_defaults(self):
        destination = self.root / 'export'
        for name in ['build-profile.json5', 'AppScope/app.json5',
                     'entry/src/main/ets/config/RuntimeDefaults.ets']:
            # Directories at protected file paths would fail any content read.
            (destination / name).mkdir(parents=True, exist_ok=True)
        baseline = self.root / 'empty.zip'
        with zipfile.ZipFile(baseline, 'w'):
            pass
        result = subprocess.run(['python3', '-B', str(ROOT / 'ohos/update-app-export.py'),
                                 '--baseline', str(baseline), '--export', str(destination)],
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('never opened or written', result.stdout)
        self.assertFalse((destination / 'LOCAL-SYNC.json').exists(), 'dry run must not write')

    def test_export_sync_protects_private_files_and_untrusted_state_paths(self):
        spec = importlib.util.spec_from_file_location('app_sync', ROOT / 'ohos/update-app-export.py')
        updater = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(updater)
        for name in ['build-profile.json5', 'local.properties', '.env', 'keys/personal.pem',
                     'signing/key.p12', 'validation/old.log', '../escape', '/absolute']:
            self.assertTrue(updater.protected_key(name), name)
        self.assertFalse(updater.protected_key('entry/src/main/ets/pages/Index.ets'))


if __name__ == '__main__':
    unittest.main(verbosity=2)

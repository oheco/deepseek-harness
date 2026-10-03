#!/usr/bin/env python3
"""Keyless tests for the independent local App project, not other packages."""
import importlib.util
import json
import os
from pathlib import Path
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
        self.assertEqual(metadata['versionName'], release['version'])
        self.assertEqual(metadata['versionName'], '0.2.0-rc.2-ohos.1')
        self.assertGreater(metadata['versionCode'], 1000001)
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
        import re
        import shlex
        home = self.root / "home with spaces '$characters"
        launcher = self.root / "launcher 'quoted' $literal.zsh"
        content = packaging.runtime_defaults(home, launcher)
        literal = re.search(r'static runCommand: string = (.+);', content)[1]
        command = json.loads(literal)
        self.assertEqual(shlex.split(command), ['zsh', str(launcher), '>',
            str(home / 'Documents/dsh-0.2.0-run.log'), '2>&1', '&'])
        self.assertNotIn('dsh web', command)
        self.assertNotIn('--port 9000', command)

    def test_page_uses_the_exported_connection_settings(self):
        page = (ROOT / 'ohos/app/entry/src/main/ets/pages/Index.ets').read_text()
        self.assertIn('const RUN_COMMAND = RuntimeDefaults.runCommand;', page)
        self.assertIn('const RUN_LOG_NAME = RuntimeDefaults.runLogName;', page)
        self.assertNotIn('dsh web --host', page)
        defaults = (ROOT / 'ohos/app/entry/src/main/ets/config/RuntimeDefaults.ets').read_text()
        self.assertIn('dsh-0.2.0-run.log', defaults)
        self.assertIn('zsh ' + str(packaging.DEFAULT_WEB_LAUNCHER), defaults)
        self.assertNotIn('dsh web', defaults)
        self.assertNotIn('0.1.7', defaults)

    def test_default_command_uses_the_independent_local_package(self):
        import re
        import shlex
        home = self.root / 'home with spaces'
        content = packaging.runtime_defaults(home)
        command = json.loads(re.search(r'static runCommand: string = (.+);', content)[1])
        self.assertEqual(shlex.split(command), ['zsh', str(packaging.DEFAULT_WEB_LAUNCHER),
            '>', str(home / 'Documents/dsh-0.2.0-run.log'), '2>&1', '&'])
        self.assertNotIn('dsh web', command)
        self.assertNotIn('0.1.7', command)

    def test_documents_permission_and_no_reverted_features(self):
        app = ROOT / 'ohos/app'
        module = json.loads((app / 'entry/src/main/module.json5').read_text())['module']
        self.assertEqual({item['name'] for item in module['requestPermissions']},
                         {'ohos.permission.INTERNET', 'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY'})
        page = (app / 'entry/src/main/ets/pages/Index.ets').read_text()
        self.assertIn('requestDocumentsAccess()', page)
        self.assertIn('picker.DocumentViewPicker', page)
        self.assertNotIn('READ_WRITE_USER_FILE', page)
        self.assertNotIn('broker', page.lower())
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
        self.assertEqual(info['release_version'], '0.2.0-rc.2-ohos.1')
        self.assertTrue(info['local_only'])
        self.assertEqual(info['web_launcher'], str(packaging.DEFAULT_WEB_LAUNCHER))
        self.assertEqual(json.loads((export / 'build-profile.json5').read_text())['app']['signingConfigs'], [])
        self.assertEqual((export / 'validation/app-migration.json').read_bytes(),
                         (ROOT / 'ohos/app-migration.json').read_bytes())
        documentation = (export / 'VALIDATION.md').read_text()
        self.assertIn('](validation/app-migration.json)', documentation)
        self.assertNotIn('](../app-migration.json)', documentation)
        archive = output / ('deepseek-harness-app-' + info['release_version'] + '.zip')
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

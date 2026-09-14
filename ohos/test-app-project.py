#!/usr/bin/env python3
"""Keyless tests for local project packaging and built upstream branding."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import struct
import zipfile

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


class DistributionBrandTests(unittest.TestCase):
    def test_release_recipe_selects_the_upstream_brand_profile(self):
        recipe = (ROOT / 'ohos/build.py').read_text()
        self.assertIn("DSH_BUILD_CLIENT_PROFILE='official'", recipe,
                      'the release build must render the upstream brand')


if __name__ == '__main__':
    unittest.main(verbosity=2)

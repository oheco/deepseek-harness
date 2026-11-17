#!/usr/bin/env python3
"""Generate every App icon resource from the upstream Web favicon's SVG path.

The HarmonyOS icon specification is a layered icon: `layered_image.json`
references a background layer and a foreground layer, and the system draws the
rounded tile itself — baking rounded corners into a bitmap is explicitly called
out as a review failure. This script therefore produces:

* ``background.png``  — 1024x1024 solid tile background.
* ``foreground.png``  — 1024x1024 transparent mark, with no self-made rounding.
* ``layered_image.json`` — the layer description both manifests reference.
* ``ability_icon.png`` (+ ``dark/`` variant) — the transparent start-window mark.
* ``app_icon.png``    — a flat, pre-rounded tile kept only as a fallback for a
  surface that cannot compose the layered icon.

Rasterization uses the `sharp` build already installed for the Harness runtime;
no new dependency is introduced.
"""
import argparse
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET

MARK_INSET = 'translate(5 5) scale(0.8)'
RUNTIME = '/storage/Users/currentUser/.oheco/packages/nodejs/24.21.0-ohos.1/lib/node_modules/@deepseek-ai/dsh/package.json'

# HarmonyOS draws a superellipse-ish tile; a 216 px icon uses a 48 px radius.
TILE_RADIUS_RATIO = 48 / 216

RASTERIZE = '''
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(process.argv[1]);
const sharp = require('sharp');
const svg = fs.readFileSync(process.argv[2], 'utf8');
const size = Number(process.argv[3]);
const png = await sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
fs.writeFileSync(process.argv[4], png);
const meta = await sharp(png).metadata();
// Alpha decides coverage, so a transparent mark is measured by its own pixels
// rather than by the black that a naive greyscale would read through them.
const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let covered = 0;
let dark = 0;
for (let index = 0; index < data.length; index += 4) {
  if (data[index + 3] <= 128) continue;
  covered += 1;
  if (data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114 < 128) dark += 1;
}
const pixels = data.length / 4;
console.log(JSON.stringify({ bytes: png.length, coverage: covered / pixels, ink: dark / pixels,
  alpha: meta.hasAlpha === true }));
'''


def node_with_sharp():
    node = os.environ.get('DSH_LOGO_NODE') or '/storage/Users/currentUser/.oheco/packages/nodejs/24.21.0-ohos.1/bin/node'
    if not Path(node).is_file():
        raise SystemExit('set DSH_LOGO_NODE to a Node executable whose runtime provides sharp')
    return node


def mark_element(root, fill):
    """Serialize the upstream path with only its paint colour replaced."""
    source = root / 'apps/web/public/favicon.svg'
    svg = ET.parse(source).getroot()
    paths = list(svg.iter('{http://www.w3.org/2000/svg}path'))
    if len(paths) != 1 or svg.get('viewBox') != '0 0 50 50':
        raise SystemExit('upstream favicon structure changed; review the App projection')
    element = ET.fromstring(ET.tostring(paths[0], encoding='unicode'))
    element.set('fill', fill)
    serialized = ET.tostring(element, encoding='unicode')
    return serialized.replace('ns0:', '').replace(':ns0', '').replace(' xmlns="http://www.w3.org/2000/svg"', '')


def wrapper(mark, backing, halo='', inset=MARK_INSET):
    """Compose one layer; a background layer carries no mark at all."""
    if inset is None:
        return ('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50">'
                f'{backing}</svg>')
    if halo != '':
        mark = mark.replace('<path', f'<path{halo}', 1)
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50">'
            f'{backing}<g transform="{inset}">{mark}</g></svg>')


def tile_backing(rounded):
    radius = f' rx="{50 * TILE_RADIUS_RATIO:.3f}"' if rounded else ''
    return f'<rect width="50" height="50"{radius} fill="#ffffff"/>'


def targets(root):
    """name, destination, size, mark fill, backing, halo, coverage band, ink band, wants alpha."""
    app = root / 'ohos/app'
    module_media = app / 'entry/src/main/resources'
    opaque = tile_backing(False)
    return [
        # The background layer is paint only: a mark here would be doubled by the
        # foreground layer and would also survive into the mask's edge.
        ('background', app / 'AppScope/resources/base/media/background.png', 1024,
         '#000000', opaque, '', (0.99, 1.0), (0.0, 0.01), False),
        ('foreground', app / 'AppScope/resources/base/media/foreground.png', 1024,
         '#000000', '', '', (0.15, 0.35), (0.15, 0.35), True),
        ('app_icon', app / 'AppScope/resources/base/media/app_icon.png', 512,
         '#000000', tile_backing(True), '', (0.90, 0.99), (0.15, 0.35), False),
        ('ability_icon', module_media / 'base/media/ability_icon.png', 512,
         '#000000', '', ' stroke="#ffffff" stroke-width="0.7" stroke-linejoin="round"',
         (0.15, 0.35), (0.15, 0.35), True),
        ('dark/ability_icon', module_media / 'dark/media/ability_icon.png', 512,
         '#ffffff', '', '', (0.15, 0.35), (0.0, 0.01), True),
    ]


def rasterize(svg_text, destination, size):
    with tempfile.TemporaryDirectory(prefix='dsh-app-logo-', dir=os.environ['TMPDIR']) as temporary:
        staged = Path(temporary) / 'icon.svg'
        staged.write_text(svg_text)
        result = subprocess.run([node_with_sharp(), '--input-type=module', '-e', RASTERIZE,
                                 RUNTIME, str(staged), str(size), str(destination)],
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    if result.returncode != 0:
        raise SystemExit('rasterization failed: ' + result.stdout.strip())
    return json.loads(result.stdout.strip().splitlines()[-1])


def png_header(path):
    header = path.read_bytes()[:26]
    if header[:8] != b'\x89PNG\r\n\x1a\n' or header[12:16] != b'IHDR':
        raise SystemExit('not a PNG: ' + str(path))
    return struct.unpack('>II', header[16:24]), header[25]


def layered_json():
    return json.dumps({'layered-image': {
        'background': '$media:background',
        'foreground': '$media:foreground',
    }}, indent=2) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    media = root / 'ohos/app/AppScope/resources/base/media'
    if (media / 'app_icon.svg').exists():
        raise SystemExit('app_icon.svg would collide with app_icon.png; delete it')
    if args.check:
        if (media / 'layered_image.json').read_text() != layered_json():
            raise SystemExit('layered_image.json no longer matches the generated layers')
        for name, destination, size, _, _, _, _, _, wants_alpha in targets(root):
            actual, colour_type = png_header(destination)
            if actual != (size, size):
                raise SystemExit(f'{name} must be {size}x{size}, found {actual}')
            if destination.stat().st_size < 512:
                raise SystemExit(f'{name} is implausibly small')
            if wants_alpha and colour_type not in (4, 6):
                raise SystemExit(f'{name} must keep an alpha channel')
        print(f'App icons: PASS ({len(targets(root))} rasters plus the layered description)')
        return
    for name, destination, size, fill, backing, halo, coverage, ink, _ in targets(root):
        destination.parent.mkdir(parents=True, exist_ok=True)
        inset = None if name == 'background' else MARK_INSET
        report = rasterize(wrapper(mark_element(root, fill), backing, halo, inset), destination, size)
        actual, _ = png_header(destination)
        if actual != (size, size) \
                or not coverage[0] <= report['coverage'] <= coverage[1] \
                or not ink[0] <= report['ink'] <= ink[1]:
            raise SystemExit(f'{name} looks wrong: size={actual} coverage={report["coverage"]:.3f} '
                             f'ink={report["ink"]:.3f}')
        print(f'{name}: {size}x{size}, {report["bytes"]} bytes, coverage {report["coverage"]:.3f}, '
              f'ink {report["ink"]:.3f}')
    (media / 'layered_image.json').write_text(layered_json())
    print('layered_image.json: background + foreground; the rounded tile is left to the system')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Export the local App ZIP using real oo and an isolated loopback-only index.

The distribution server exists only for this operation, serves exactly two
files, binds an OS-selected loopback port, and is shut down in finally. The
normal oo root and the official catalog are never changed.
"""
import argparse
import copy
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import uuid
import zipfile


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive-dir', type=Path, required=True)
    parser.add_argument('--descriptor', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    directory = args.archive_dir.resolve()
    archive = directory / 'deepseek-harness-app-local.zip'
    artifact = json.loads((directory / 'project-artifact.json').read_text())
    if digest(archive) != artifact['sha256'] or archive.stat().st_size != artifact['size']:
        parser.error('archive no longer matches its recorded size and checksum')
    destination = args.output.resolve()
    if destination.exists():
        parser.error('output must be a new directory; existing user exports are not replaced')
    descriptor = copy.deepcopy(json.loads(args.descriptor.read_text()))
    version_name = descriptor['latest']['ohos-arm64']
    version = next(item for item in descriptor['versions'] if item['version'] == version_name)
    descriptor['schema_version'] = 4
    descriptor['versions'] = [version]
    descriptor['latest'] = {'ohos-arm64': version_name}
    descriptor['notes'] = 'LOCAL ONLY: experimental App project; no public catalog or Release change.'
    prefix = '/' + uuid.uuid4().hex
    routes = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path not in routes:
                self.send_error(404)
                return
            source, content_type = routes[self.path]
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(source.stat().st_size))
            self.end_headers()
            with source.open('rb') as stream:
                shutil.copyfileobj(stream, self.wfile)

        def log_message(self, *unused):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    started = False
    try:
        with tempfile.TemporaryDirectory(prefix='dsh-project-export-', dir=os.environ['TMPDIR']) as temporary:
            private = Path(temporary)
            index_path = private / 'index.json'
            url = f'http://127.0.0.1:{server.server_port}{prefix}'
            artifact['url'] = url + '/project.zip'
            version['projects'] = {'app': artifact}
            index = {'schema_version': 4,
                     'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                     'packages': [descriptor]}
            index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n')
            routes[prefix + '/index.json'] = (index_path, 'application/json')
            routes[prefix + '/project.zip'] = (archive, 'application/zip')
            thread.start()
            started = True
            temp = private / 'tmp'
            temp.mkdir(mode=0o700)
            env = dict(os.environ, OHECO_ROOT=str(private / 'oo'), TMPDIR=str(temp),
                       OHECO_INDEX_URL=url + '/index.json', OHECO_NO_AUTO_UPDATE='1')
            oo = shutil.which('oo')
            if oo is None:
                parser.error('oo is required')
            commands = [[oo, 'update'],
                        [oo, 'info', 'deepseek-harness'],
                        [oo, 'export', 'deepseek-harness@' + version_name, 'app', '--output', str(destination)]]
            log = []
            for command in commands:
                result = subprocess.run(command, env=env, text=True, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, timeout=300)
                log.append(result.stdout)
                print(result.stdout, end='')
                result.check_returncode()
            count = 0
            with zipfile.ZipFile(archive) as bundle:
                for info in bundle.infolist():
                    if info.is_dir():
                        continue
                    target = destination / Path(info.filename).relative_to('DSHApp')
                    with bundle.open(info) as stream:
                        wanted = hashlib.file_digest(stream, 'sha256').hexdigest()
                    if not target.is_file() or digest(target) != wanted:
                        raise ValueError(f'exported bytes differ from archive: {target}')
                    count += 1
            report = {'published': False, 'exported_with': 'oo export',
                      'archive_sha256': artifact['sha256'], 'verified_files': count,
                      'destination': str(destination), 'temporary_server_stopped_on_exit': True}
            (directory / 'export-verification.json').write_text(json.dumps(report, indent=2) + '\n')
            (directory / 'oo-export.log').write_text('\n'.join(log))
            print(f'Verified {count} exported files. Official index and installed packages unchanged.')
    finally:
        if started:
            server.shutdown()
            thread.join()
        server.server_close()


if __name__ == '__main__':
    main()

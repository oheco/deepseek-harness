/** Build the independent POSIX flock oracle used by native behavior tests. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!['linux', 'darwin', 'openharmony'].includes(process.platform)) {
  throw new Error('The flock oracle is a POSIX test fixture');
}
const variants = process.platform === 'linux' ? ['glibc', 'musl'] : [''];
for (const variant of variants) {
  const compiler = variant === 'musl' ? 'musl-gcc' : process.platform === 'openharmony' ? 'clang' : 'cc';
  const output = path.join(root, 'test/bin', variant, 'flock-oracle');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const args = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'];
  if (process.platform === 'darwin') args.push('-mmacosx-version-min=11.0');
  if (variant === 'musl') args.push('-static');
  const temporary = fs.mkdtempSync(path.join(tmpdir(), 'flock-oracle-'));
  try {
    const pending = path.join(temporary, 'flock-oracle');
    const result = spawnSync(compiler, [...args, path.join(root, 'test/fixtures/flock-oracle.c'), '-o', pending], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${compiler} failed to build the flock oracle`);
    if (process.platform === 'openharmony') {
      if (!process.env.XDG_CACHE_HOME) throw new Error('HarmonyOS oracle requires application-private XDG_CACHE_HOME');
      const signed = pending + '.signed';
      const signature = spawnSync('binary-sign-tool', ['sign', '-inFile', pending, '-outFile', signed, '-selfSign', '1'], { stdio: 'inherit' });
      if (signature.error) throw signature.error;
      if (signature.status !== 0) throw new Error('HarmonyOS oracle signing failed');
      // Shared HOME ignores executable chmod; execute the private cached binary.
      const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
      const cache = path.join(process.env.XDG_CACHE_HOME, 'dsh-flock-oracle', key);
      fs.mkdirSync(cache, { recursive: true });
      const binary = path.join(cache, 'flock-oracle');
      fs.copyFileSync(signed, binary);
      fs.chmodSync(binary, 0o755);
      fs.rmSync(output, { force: true });
      fs.symlinkSync(binary, output);
    } else {
      fs.copyFileSync(pending, output);
      fs.chmodSync(output, 0o755);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`Built test oracle ${path.relative(root, output)}`);
}

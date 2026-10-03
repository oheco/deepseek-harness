#!/usr/bin/env python3
"""Build/sign native fixtures in private cache; never start a real dsh web."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def run(*args):
    print('+', ' '.join(str(arg) for arg in args), flush=True)
    subprocess.run([str(arg) for arg in args], check=True)


def main():
    source = Path(__file__).resolve().parent
    cache = Path(os.environ['XDG_CACHE_HOME'])
    if not cache.is_absolute() or not cache.is_dir():
        raise RuntimeError('XDG_CACHE_HOME must be an existing private cache directory')
    for tool in ('clang++', 'cmake', 'ninja', 'binary-sign-tool'):
        if shutil.which(tool) is None:
            raise RuntimeError(f'{tool} missing; check SDK LLVM/toolchains PATH')
    build = Path(tempfile.mkdtemp(prefix='dsh-launcher-native-', dir=cache))
    print(f'PRIVATE_BUILD={build}', flush=True)
    options = ('-G', 'Ninja', '-DCMAKE_CXX_COMPILER=clang++',
               '-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY', '-DCMAKE_BUILD_TYPE=Debug')
    run('cmake', '-S', source, '-B', build, *options)
    run('cmake', '--build', build, '--parallel', '2')
    binaries = ('fixture with spaces', 'dsh_supervisor_test', 'dsh_probe_test', 'dsh_launcher_smoke')
    for name in binaries:
        binary = build / name
        signed = binary.with_name(binary.name + '.signed')
        run('binary-sign-tool', 'sign', '-inFile', binary, '-outFile', signed, '-selfSign', '1')
        os.replace(signed, binary)
        binary.chmod(0o700)
    run('ctest', '--test-dir', build, '--output-on-failure')
    # Linking validates the actual SDK NAPI declarations and libace_napi ABI,
    # without loading ArkTS code into the terminal's Node runtime.
    run('cmake', '-S', source / '../../entry/src/main/cpp', '-B', build / 'napi', *options)
    run('cmake', '--build', build / 'napi', '--parallel', '2')
    print(f'PASS native fixtures (supervisor + capability probe) and NAPI link; artifacts retained at {build}', flush=True)
    print('NOT RUN: dsh_launcher_smoke (requires separately managed real-service approval)', flush=True)


if __name__ == '__main__':
    main()

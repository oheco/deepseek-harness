#!/usr/bin/env python3
"""Run the exported template's offline native broker dependency preparation."""
import argparse
from pathlib import Path
import runpy

if __name__ == '__main__':
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--cpp', type=Path)
    args, _ = parser.parse_known_args()
    cpp = args.cpp.resolve() if args.cpp else Path(__file__).resolve().parent / 'app/entry/src/main/cpp'
    runpy.run_path(str(cpp / 'prepare_native.py'), run_name='__main__')

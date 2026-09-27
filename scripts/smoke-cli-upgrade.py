#!/usr/bin/env python3
"""Upgrade a disposable copy of bh using an actual published release."""
from pathlib import Path
import argparse, shutil, subprocess, tempfile
parser=argparse.ArgumentParser()
parser.add_argument('--version', required=True)
args=parser.parse_args()
root=Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='boxhaven-upgrade-smoke-') as temp:
    executable=Path(temp)/'bh'
    shutil.copy2(root/'bh', executable)
    subprocess.run([str(executable), 'upgrade', '--version', args.version], check=True)
    output=subprocess.check_output([str(executable), 'version'], text=True)
    assert output.startswith('bh '+args.version+' ('), output
    assert not Path(str(executable)+'.upgrade-lock').exists()
    print('Published CLI upgrade passed:', output.strip())

#!/usr/bin/env python3
"""Install the complete skill into a disposable project using Vercel's CLI."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source", default=str(ROOT), help="Local checkout or published owner/repo#ref")
args = parser.parse_args()
environment = dict(os.environ, DISABLE_TELEMETRY="1")


def run(command, cwd):
    result = subprocess.run(command, cwd=cwd, env=environment, capture_output=True, text=True, timeout=180)
    if result.returncode:
        print(result.stdout, file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        raise SystemExit(result.returncode)
    return result.stdout


def files(directory):
    return {str(path.relative_to(directory)): path.read_bytes()
            for path in directory.rglob("*") if path.is_file()}


with tempfile.TemporaryDirectory(prefix="boxhaven-skill-install-") as temporary:
    project = Path(temporary)
    cli = ["npx", "--yes", "skills@1.5.24"]
    run(cli + ["add", args.source, "--skill", "boxhaven", "-a", "codex", "claude-code", "-y"], project)
    installed = project / ".agents/skills/boxhaven"
    expected = files(ROOT / "skills/boxhaven")
    assert files(installed) == expected, "installed skill must include all source files unchanged"
    assert (project / ".claude/skills/boxhaven").resolve() == installed.resolve(), "Claude must share the installed package"
    lock = json.loads((project / "skills-lock.json").read_text())
    entry = lock["skills"]["boxhaven"]
    assert entry["computedHash"], "installer must record package contents for updates"
    if "#" in args.source:
        assert entry["ref"] == args.source.rsplit("#", 1)[1], "installer must retain the requested Git ref"
        run(cli + ["update", "boxhaven", "-p", "-y"], project)
        updated = json.loads((project / "skills-lock.json").read_text())["skills"]["boxhaven"]
        assert updated["ref"] == entry["ref"], "update must preserve the requested Git ref"
        assert files(installed) == expected, "pinned update must preserve the package"
    run([sys.executable, str(installed / "scripts/launch.py"), "--help"], project)
    print(f"Verified Skills CLI installation for Codex and Claude: {len(expected)} files, lock tracking, and launcher")

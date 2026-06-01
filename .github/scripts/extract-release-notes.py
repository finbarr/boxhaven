#!/usr/bin/env python3
import pathlib
import re
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: extract-release-notes.py <tag> <changelog>", file=sys.stderr)
        return 2

    tag = sys.argv[1]
    changelog = pathlib.Path(sys.argv[2])
    version = tag[1:] if tag.startswith("v") else tag
    if not changelog.exists():
        print(f"See CHANGELOG.md for {tag}.")
        return 0

    lines = changelog.read_text(encoding="utf-8").splitlines()
    heading = re.compile(rf"^##\s+v?{re.escape(version)}(?:\s+-.*)?\s*$")
    unreleased_heading = re.compile(r"^##\s+Unreleased\s*$", re.IGNORECASE)

    start = None
    for idx, line in enumerate(lines):
        if heading.match(line.strip()):
            start = idx
            break

    if start is None:
        for idx, line in enumerate(lines):
            if unreleased_heading.match(line.strip()):
                start = idx
                break

    if start is None:
        print(f"See CHANGELOG.md for {tag}.")
        return 0

    end = len(lines)
    for idx in range(start + 1, len(lines)):
        if lines[idx].startswith("## "):
            end = idx
            break

    section = "\n".join(lines[start:end]).strip()
    print(section if section else f"See CHANGELOG.md for {tag}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

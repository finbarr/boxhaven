#!/usr/bin/env python3
"""Exercise the public launch helper without creating cloud resources."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

LAUNCHER = Path(__file__).resolve().parents[1] / "skills/boxhaven/scripts/launch.py"


class LaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.fake = self.root / "bh"
        self.fake.write_text("#!" + sys.executable + "\n" + '''
import json, pathlib, sys, time
root = pathlib.Path(__file__).parent
args = sys.argv[1:]
with (root / "calls.jsonl").open("a") as f:
    f.write(json.dumps({"args": args, "cwd": str(pathlib.Path.cwd()), "time": time.monotonic()}) + "\\n")
if args[0] == "list":
    print("NAME STATUS")
    if (root / "existing").exists(): print("task-b online")
elif args[0] == "create":
    time.sleep(0.4)
    if (root / "fail-create").exists() and args[1] == "task-a": sys.exit(1)
elif args[0] == "run":
    assert not sys.stdin.isatty() and not sys.stdout.isatty()
''')
        self.fake.chmod(0o755)
        self.jobs = []
        for name in ("task-a", "task-b"):
            (self.root / name).mkdir()
            self.jobs.append({"name": name, "directory": name, "agent": ["codex", "Read TASK.md; keep literal $(text) and `text`."]})

    def tearDown(self):
        self.temp.cleanup()

    def launch(self):
        manifest = self.root / "tasks.json"
        manifest.write_text(json.dumps(self.jobs))
        return subprocess.run([sys.executable, str(LAUNCHER), str(manifest), "--bh", str(self.fake), "--jobs", "2"], capture_output=True, text=True)

    def calls(self):
        path = self.root / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_parallel_launch_preserves_arguments_and_checks_before_creates(self):
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual([call["args"][0] for call in calls[:2]], ["list", "list"])
        creates = [call for call in calls if call["args"][0] == "create"]
        self.assertLess(abs(creates[0]["time"] - creates[1]["time"]), 0.3)
        for job in self.jobs:
            launch = next(call for call in calls if call["args"][:3] == ["run", job["name"], "codex"])
            self.assertEqual(launch["args"][3:], job["agent"][1:])
            self.assertEqual(launch["cwd"], str(self.root / job["directory"]))

    def test_existing_name_prevents_all_creates(self):
        (self.root / "existing").touch()
        self.assertNotEqual(self.launch().returncode, 0)
        self.assertTrue(all(call["args"][0] == "list" for call in self.calls()))

    def test_partial_failure_does_not_launch_failed_box_or_stop_other_box(self):
        (self.root / "fail-create").touch()
        result = self.launch()
        self.assertEqual(result.returncode, 1, result.stderr)
        commands = [call["args"] for call in self.calls()]
        self.assertNotIn(["status", "task-a"], commands)
        self.assertTrue(any(command[:3] == ["run", "task-b", "codex"] for command in commands))
        self.assertFalse(any(command[0] == "destroy" for command in commands))

    def test_overlapping_workspaces_fail_before_cli(self):
        self.jobs[1]["directory"] = self.jobs[0]["directory"]
        self.assertNotEqual(self.launch().returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_invalid_command_fails_before_cli(self):
        self.jobs[1]["agent"] = "codex Read TASK.md"
        self.assertNotEqual(self.launch().returncode, 0)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()

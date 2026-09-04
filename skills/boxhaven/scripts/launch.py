#!/usr/bin/env python3
"""Create isolated BoxHaven boxes and start Codex/Claude sessions concurrently."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time

CREATE_OPTIONS = ("size", "provider", "region", "image", "team")
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def read_jobs(manifest):
    jobs = json.loads(manifest.read_text())
    if not isinstance(jobs, list) or not jobs:
        raise ValueError("manifest must be a nonempty JSON array")
    names, directories = set(), []
    for job in jobs:
        if not isinstance(job, dict) or set(job) - {"name", "directory", "agent", *CREATE_OPTIONS}:
            raise ValueError("each job must contain name, directory, agent, and optional create settings")
        name = job.get("name", "")
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", name) or name in names:
            raise ValueError(f"invalid or duplicate box name: {name!r}")
        names.add(name)
        if not isinstance(job.get("directory"), str) or not job["directory"].strip():
            raise ValueError(f"{name}: directory is required")
        directory = (manifest.parent / job["directory"]).resolve()
        if not directory.is_dir():
            raise ValueError(f"{name}: directory does not exist: {directory}")
        if any(directory == other or directory in other.parents or other in directory.parents for other in directories):
            raise ValueError(f"{name}: task directories must be separate and not nested")
        directories.append(directory)
        job["directory"] = directory
        agent = job.get("agent")
        if not isinstance(agent, list) or not agent or not all(isinstance(arg, str) and arg for arg in agent) or agent[0] not in ("codex", "claude"):
            raise ValueError(f"{name}: agent must be an argument array starting with codex or claude")
        for option in CREATE_OPTIONS:
            if option in job and (not isinstance(job[option], str) or not job[option].strip()):
                raise ValueError(f"{name}: {option} must be a nonempty string")
    return jobs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--jobs", type=int, default=4, help="maximum simultaneous box launches (default: 4)")
    parser.add_argument("--bh", default="bh", help="bh executable name or path")
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    try:
        jobs = read_jobs(args.manifest.resolve())
    except (ValueError, OSError) as error:
        parser.error(str(error))
    executable = shutil.which(args.bh)
    if not executable:
        parser.error(f"bh executable not found: {args.bh}")
    executable = str(Path(executable).resolve())

    # Use each project's configuration: projects may select different backends.
    # Finish all preflight checks before issuing any create request.
    for job in jobs:
        result = subprocess.run([executable, "list"], cwd=job["directory"], stdin=subprocess.DEVNULL, capture_output=True, text=True)
        if result.returncode:
            parser.error(f"{job['name']}: bh list failed; check login/configuration. {result.stderr.strip()}")
        existing = {line.split()[0] for line in ANSI.sub("", result.stdout).splitlines() if line.split()}
        if job["name"] in existing:
            parser.error(f"box already exists: {job['name']}; inspect it before retrying")

    # Keep logs outside every synced task directory, even if its manifest lives
    # inside the project. Uploading an actively written create log breaks rsync.
    logs = Path(tempfile.mkdtemp(prefix="boxhaven-launch-"))
    lock = threading.Lock()
    print(f"Logs: {logs}", flush=True)

    def event(name, stage, state, **details):
        record = {"utc": datetime.now(timezone.utc).isoformat(), "name": name, "stage": stage, "state": state, **details}
        with lock:
            with (logs / "events.jsonl").open("a") as stream:
                stream.write(json.dumps(record) + "\n")
            print(json.dumps(record), flush=True)

    def launch(job):
        name, stage = job["name"], "create"
        create = ["create", name]
        for option in CREATE_OPTIONS:
            if option in job:
                create.extend([f"--{option}", job[option]])
        commands = [
            ("create", create),
            ("status", ["status", name]),
            ("version", ["run", name, "env", "BOXHAVEN_NO_FULL_AUTO=1", job["agent"][0], "--version"]),
            ("launch", ["run", name, *job["agent"]]),
        ]
        try:
            for stage, command in commands:
                started = time.monotonic()
                event(name, stage, "started")
                with (logs / f"{name}-{stage}.log").open("w") as stream:
                    result = subprocess.run([executable, *command], cwd=job["directory"], stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT)
                event(name, stage, "ok" if result.returncode == 0 else "failed", returncode=result.returncode, seconds=round(time.monotonic() - started, 2))
                if result.returncode:
                    return {"name": name, "state": "failed", "stage": stage}
            return {"name": name, "state": "session_launched", "stage": stage}
        except OSError as error:
            event(name, stage, "failed", error=str(error))
            return {"name": name, "state": "failed", "stage": stage}

    with ThreadPoolExecutor(max_workers=min(args.jobs, len(jobs))) as pool:
        results = [future.result() for future in as_completed([pool.submit(launch, job) for job in jobs])]
    results.sort(key=lambda result: result["name"])
    (logs / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print("Boxes are left running. Inspect session output before reporting agents working or tasks complete.", flush=True)
    return int(any(result["state"] == "failed" for result in results))


if __name__ == "__main__":
    raise SystemExit(main())

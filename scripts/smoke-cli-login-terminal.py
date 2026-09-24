#!/usr/bin/env python3
"""Exercise first-login selection in a real PTY using a test account token.

Set BOXHAVEN_SMOKE_CREDENTIALS to the self-hosted smoke account JSON. Config is
isolated and removed afterward; the original account session is not revoked.
"""
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import tempfile
import time
import tomllib

credentials = json.loads(Path(os.environ["BOXHAVEN_SMOKE_CREDENTIALS"]).read_text())
backend_url = credentials["apiURL"]
binary = Path(os.environ.get("BOXHAVEN_SMOKE_BH", Path(__file__).resolve().parent.parent / "bh"))
with tempfile.TemporaryDirectory(prefix="boxhaven-terminal-login-") as config_dir:
    env = {**os.environ, "XDG_CONFIG_HOME": config_dir, "BOXHAVEN_BACKEND_URL": "", "BOXHAVEN_TOKEN": ""}
    master, slave = pty.openpty()
    child = subprocess.Popen([str(binary), "login", "--token", credentials["token"]],
                             stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    output = b""
    selected = False
    deadline = time.monotonic() + 30
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
                if not selected and b"Backend URL [https://api.boxhaven.dev]:" in output:
                    os.write(master, (backend_url + "\n").encode())
                    selected = True
            if child.poll() is not None:
                break
        assert selected, "first login must show a backend URL prompt with the hosted suggestion"
        assert child.wait(timeout=5) == 0, "terminal login must succeed"
        config = tomllib.loads((Path(config_dir) / "boxhaven/config.toml").read_text())
        assert config["remote"]["backend_url"] == backend_url, "must save the chosen URL"
        assert config["remote"]["token"] == credentials["token"], "must save the provided session"
        assert f"Logged in to {backend_url}".encode() in output
        print("Terminal login prompt, self-hosted selection, and saved configuration verified.")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)

"""Starts provider_dev_server.js for the contract suite when GD_DEV_SERVER is set (or uses GD_SDK_BASE)."""
import json
import os
import subprocess

import pytest


@pytest.fixture(scope="session")
def base():
    if os.environ.get("GD_SDK_BASE"):
        yield os.environ["GD_SDK_BASE"]
        return
    script = os.environ.get("GD_DEV_SERVER")
    if not script:
        pytest.skip("set GD_SDK_BASE or GD_DEV_SERVER to run the contract suite")
    proc = subprocess.Popen(["node", script, "--exit-with-stdin"], env={**os.environ, "PROVIDER_V1_ENABLED": "true"},
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        yield json.loads(proc.stdout.readline())["base"]
    finally:
        proc.stdin.close()
        proc.terminate()
        proc.wait(10)

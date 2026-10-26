"""Tests for version.py (the next release number for the manual release workflow).

Run: uv run --with pytest pytest tools/tests
"""

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("version", TOOLS / "version.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

TAGS = ["1.0.0", "1.0.3", "0.9.0", "v2.0.0", "build-abc"]


@pytest.mark.parametrize(
    ("bump", "expected"),
    [("patch", "1.0.4"), ("minor", "1.1.0"), ("major", "2.0.0")],
)
def test_bump_the_latest_release(bump, expected):
    assert mod.next_version(TAGS, bump) == expected


def test_bump_compares_versions_numerically():
    assert mod.next_version(["1.9.0", "1.10.0"], "patch") == "1.10.1"


def test_bump_without_releases_starts_from_0_0_0():
    assert mod.next_version([], "patch") == "0.0.1"
    assert mod.next_version(["v1.0"], "major") == "1.0.0"


def test_explicit_version_overrides_the_bump():
    assert mod.next_version(TAGS, "patch", "1.2.0") == "1.2.0"
    assert mod.next_version(TAGS, "patch", " 3.0.0 ") == "3.0.0"


@pytest.mark.parametrize("bad", ["v1.2.0", "1.2", "1.2.0-rc1", "01.2.0", "x"])
def test_explicit_version_must_be_x_y_z(bad):
    with pytest.raises(ValueError, match="x.y.z"):
        mod.next_version(TAGS, "patch", bad)


@pytest.mark.parametrize("old", ["1.0.3", "1.0.0", "0.1.0"])
def test_explicit_version_must_be_higher_than_the_latest(old):
    with pytest.raises(ValueError, match="1.0.3"):
        mod.next_version(TAGS, "patch", old)


def test_unknown_bump_fails():
    with pytest.raises(ValueError, match="major, minor or patch"):
        mod.next_version(TAGS, "huge")


def test_cli_prints_the_version_from_the_repository_tags(tmp_path: Path):
    def git(*args):
        subprocess.run(["git", "-C", str(tmp_path), *args], check=True, capture_output=True)

    git("init", "-q")
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "a")
    git("tag", "1.0.3")
    run = lambda *a: subprocess.run([sys.executable, str(TOOLS / "version.py"), *a, "--repo", str(tmp_path)], capture_output=True, text=True)
    assert run("minor").stdout == "1.1.0\n"
    assert run("patch", "--version", "").stdout == "1.0.4\n"
    bad = run("patch", "--version", "1.0.0")
    assert bad.returncode != 0 and "1.0.3" in bad.stderr

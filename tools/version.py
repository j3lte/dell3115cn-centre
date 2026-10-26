#!/usr/bin/env python3
"""The next release number, for the manual release workflow.

Bumps the latest x.y.z tag (major, minor or patch; 0.0.0 when there is none), or checks an explicit version: it must
be x.y.z and higher than the latest release.

Usage: version.py {major,minor,patch} [--version X.Y.Z] [--repo DIR]
"""
import argparse
import re
import subprocess
from pathlib import Path

from changelog import RELEASE, version

STRICT = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
BUMPS = ("major", "minor", "patch")


def next_version(tags: list[str], bump: str, explicit: str = "") -> str:
    latest = max((t for t in tags if RELEASE.match(t)), key=version, default="0.0.0")
    explicit = explicit.strip()
    if explicit:
        if not STRICT.match(explicit):
            raise ValueError(f"version must be x.y.z (no 'v', no leading zeros): {explicit}")
        if version(explicit) <= version(latest):
            raise ValueError(f"version {explicit} must be higher than the latest release {latest}")
        return explicit
    if bump not in BUMPS:
        raise ValueError(f"bump must be major, minor or patch: {bump}")
    major, minor, patch = version(latest)
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("bump")
    p.add_argument("--version", default="")
    p.add_argument("--repo", type=Path, default=Path("."))
    a = p.parse_args()
    tags = subprocess.run(["git", "-C", str(a.repo), "tag", "--list"], check=True, capture_output=True, text=True).stdout.split()
    try:
        print(next_version(tags, a.bump, a.version))
    except ValueError as e:
        p.error(str(e))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Turns the [Unreleased] section of CHANGELOG.md into a release.

`## [Unreleased]` becomes `## [x.y.z](<link comparing it with the previous release>)`, and a new, empty
`## [Unreleased]` goes above it. Prints the release's items plus the compare link: the GitHub release notes. When
[Unreleased] lists nothing, the release lists its commits instead (without merges and CI's changelog commits). A
version already in the changelog is left as it is, so a re-run changes nothing. Release tags are x.y.z (no "v"); the
previous release is the highest lower version.

Usage: changelog.py TAG REPO_URL [--repo DIR] [--changelog CHANGELOG.md]
"""
import argparse
import re
import subprocess
from pathlib import Path

RELEASE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
UNRELEASED = re.compile(r"^## \[Unreleased\][ \t]*$", re.M)
NEXT_SECTION = re.compile(r"^## ", re.M)
CHANGELOG_COMMIT = "docs(changelog):"


def version(tag: str) -> tuple[int, int, int]:
    return tuple(int(n) for n in RELEASE.match(tag).groups())


def previous_tag(tags: list[str], tag: str) -> str | None:
    lower = [t for t in tags if RELEASE.match(t) and version(t) < version(tag)]
    return max(lower, key=version, default=None)


def link(repo_url: str, tag: str, prev: str | None) -> str:
    return f"{repo_url}/compare/{prev}...{tag}" if prev else f"{repo_url}/commits/{tag}"


def commits(repo: Path, tag: str, prev: str | None) -> list[tuple[str, str]]:
    rev = f"{prev}..{tag}" if prev else tag
    out = subprocess.run(
        ["git", "-C", str(repo), "log", "--no-merges", "--format=%s%x09%h", rev],
        check=True, capture_output=True, text=True,
    ).stdout
    pairs = [tuple(line.rsplit("\t", 1)) for line in out.splitlines() if line]
    return [(s, h) for s, h in pairs if not s.startswith(CHANGELOG_COMMIT)]


def _body(text: str, start: int) -> tuple[str, int]:
    """The section text from `start` up to the next `## ` heading, and where that heading starts."""
    m = NEXT_SECTION.search(text, start)
    end = m.start() if m else len(text)
    return text[start:end], end


def release(text: str, tag: str, url: str, fallback: list[tuple[str, str]]) -> tuple[str, str]:
    """(new changelog, the release's items)."""
    done = re.search(rf"^## \[{re.escape(tag)}\].*$", text, re.M)
    if done:
        return text, _body(text, done.end())[0].strip() + "\n"
    m = UNRELEASED.search(text)
    if not m:
        raise ValueError("CHANGELOG.md has no ## [Unreleased] section")
    body, end = _body(text, m.end())
    items = body.strip() or "\n".join(f"- {s} ({h})" for s, h in fallback) or "- No notable changes."
    items += "\n"
    rest = text[end:]
    new = text[: m.start()] + "## [Unreleased]\n\n\n\n" + f"## [{tag}]({url})\n\n" + items + ("\n" + rest if rest else "")
    return new, items


def notes(items: str, url: str) -> str:
    return f"{items}\n**Full changelog:** {url}\n"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("tag")
    p.add_argument("repo_url")
    p.add_argument("--repo", type=Path, default=Path("."))
    p.add_argument("--changelog", type=Path, default=Path("CHANGELOG.md"))
    a = p.parse_args()
    if not RELEASE.match(a.tag):
        p.error(f"not a release tag (x.y.z): {a.tag}")
    tags = subprocess.run(["git", "-C", str(a.repo), "tag", "--list"], check=True, capture_output=True, text=True).stdout.split()
    prev = previous_tag(tags, a.tag)
    url = link(a.repo_url.rstrip("/"), a.tag, prev)
    try:
        new, items = release(a.changelog.read_text(), a.tag, url, commits(a.repo, a.tag, prev))
    except ValueError as e:
        p.error(str(e))
    a.changelog.write_text(new)
    print(notes(items, url), end="")


if __name__ == "__main__":
    main()

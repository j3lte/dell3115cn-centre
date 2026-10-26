"""Tests for changelog.py (turns CHANGELOG.md's [Unreleased] section into a release).

Run: uv run --with pytest pytest tools/tests
"""

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parent.parent / "changelog.py"

spec = importlib.util.spec_from_file_location("changelog", TOOL)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

URL = "https://github.com/owner/repo"
INTRO = "# Changelog\n\nNotable changes per release.\n\n"


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.name", "t")
    git(tmp_path, "config", "user.email", "t@example.com")
    git(tmp_path, "config", "commit.gpgsign", "false")
    git(tmp_path, "config", "tag.gpgsign", "false")
    return tmp_path


def commit(repo: Path, subject: str) -> str:
    git(repo, "commit", "-q", "--allow-empty", "-m", subject)
    return git(repo, "rev-parse", "--short", "HEAD")


def test_previous_tag_is_the_highest_lower_version():
    tags = ["1.0.0", "1.2.0", "1.10.0", "1.9.1", "2.0.0", "v0.1", "build-abc"]
    assert mod.previous_tag(tags, "1.10.0") == "1.9.1"
    assert mod.previous_tag(tags, "2.0.0") == "1.10.0"


def test_previous_tag_of_the_first_release_is_none():
    assert mod.previous_tag(["1.0.0", "v0.1"], "1.0.0") is None


def test_link_compares_with_the_previous_tag():
    assert mod.link(URL, "1.1.0", "1.0.0") == "https://github.com/owner/repo/compare/1.0.0...1.1.0"


def test_link_of_the_first_release_lists_its_commits():
    assert mod.link(URL, "1.0.0", None) == "https://github.com/owner/repo/commits/1.0.0"


def test_release_renames_unreleased_and_opens_a_new_one():
    text = INTRO + "## [Unreleased]\n\n- feat: b\n- fix: c\n\n## [1.0.0](u)\n\n- a\n"
    new, items = mod.release(text, "1.1.0", "L", [])
    assert new == INTRO + "## [Unreleased]\n\n\n\n## [1.1.0](L)\n\n- feat: b\n- fix: c\n\n## [1.0.0](u)\n\n- a\n"
    assert items == "- feat: b\n- fix: c\n"


def test_release_of_the_last_section():
    new, items = mod.release(INTRO + "## [Unreleased]\n\n- a\n", "1.0.0", "L", [])
    assert new == INTRO + "## [Unreleased]\n\n\n\n## [1.0.0](L)\n\n- a\n"
    assert items == "- a\n"


def test_release_with_nothing_listed_uses_the_commits():
    text = INTRO + "## [Unreleased]\n\n\n\n## [1.0.0](u)\n\n- a\n"
    new, items = mod.release(text, "1.1.0", "L", [("feat: x", "abc1234")])
    assert items == "- feat: x (abc1234)\n"
    assert new == INTRO + "## [Unreleased]\n\n\n\n## [1.1.0](L)\n\n- feat: x (abc1234)\n\n## [1.0.0](u)\n\n- a\n"


def test_release_already_in_the_changelog_is_left_alone():
    text = INTRO + "## [Unreleased]\n\n- next\n\n## [1.1.0](L)\n\n- b\n\n## [1.0.0](u)\n\n- a\n"
    assert mod.release(text, "1.1.0", "L", []) == (text, "- b\n")


def test_release_without_unreleased_section_fails():
    with pytest.raises(ValueError, match=r"\[Unreleased\]"):
        mod.release(INTRO + "## [1.0.0](u)\n\n- a\n", "1.1.0", "L", [])


def test_notes_end_with_the_full_changelog_link():
    assert mod.notes("- a\n", "L") == "- a\n\n**Full changelog:** L\n"


def test_commits_between_tags_skip_merges_and_changelog_commits(repo: Path):
    commit(repo, "first")
    git(repo, "tag", "1.0.0")
    a = commit(repo, "feat: a")
    commit(repo, "docs(changelog): 1.0.0")
    git(repo, "switch", "-q", "-c", "side")
    b = commit(repo, "fix: b")
    git(repo, "switch", "-q", "main")
    git(repo, "merge", "-q", "--no-ff", "-m", "Merge branch side", "side")
    git(repo, "tag", "1.1.0")
    assert sorted(mod.commits(repo, "1.1.0", "1.0.0")) == sorted([("feat: a", a), ("fix: b", b)])


def test_commits_of_the_first_release_are_all_commits(repo: Path):
    a = commit(repo, "first")
    git(repo, "tag", "1.0.0")
    assert mod.commits(repo, "1.0.0", None) == [("first", a)]


def test_cli_updates_the_changelog_and_prints_the_notes(repo: Path):
    commit(repo, "first")
    git(repo, "tag", "1.0.0")
    commit(repo, "feat: a")
    git(repo, "tag", "1.1.0")
    changelog = repo / "CHANGELOG.md"
    changelog.write_text(INTRO + "## [Unreleased]\n\n- Feature a\n\n## [1.0.0](u)\n\n- first\n")
    out = subprocess.run(
        [sys.executable, str(TOOL), "1.1.0", URL, "--repo", str(repo), "--changelog", str(changelog)],
        check=True, capture_output=True, text=True,
    ).stdout
    assert out == f"- Feature a\n\n**Full changelog:** {URL}/compare/1.0.0...1.1.0\n"
    assert changelog.read_text() == (
        INTRO + f"## [Unreleased]\n\n\n\n## [1.1.0]({URL}/compare/1.0.0...1.1.0)\n\n- Feature a\n\n## [1.0.0](u)\n\n- first\n"
    )

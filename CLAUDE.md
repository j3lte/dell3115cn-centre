# CLAUDE.md

Scanning and printing for the Dell MFP Laser 3115cn on Linux. The scanner has no SANE/Linux driver; its USB protocol
was reverse-engineered and is documented in `docs/PROTOCOL.md`.

@.claude/local.md

## Layout

| Path | What |
|---|---|
| `docs/PROTOCOL.md` | The USB scan protocol (authoritative). Read it before touching scanner code. |
| `docs/PRINTER.md` | The device, firmware, CUPS analysis, printing speed, PCL XL driver, status record (supplies, alerts, page count), network port. |
| `docs/SCAN-QUALITY.md` | Resolution and bit-depth limits, measured sharpness, deconvolution, tracking dots. |
| `docs/ANALYSE.md` | User docs for the web app's Analyse section (tracking dots, DEDA) and the `analyse/` service: detection, API, privacy. |
| `docs/REVERSE-ENGINEERING.md` | How the Dell drivers were decompiled and findings verified. |
| `docs/screenshots/` | Web app screenshots for the READMEs (see Workflow). |
| `docs/architecture.svg`, `docs/dell-3115cn.jpg` | README diagram (light/dark via `prefers-color-scheme`) and printer photo (© Dell). |
| `scanner-service/` | Python service on the print server: owns USB interface 0, HTTP + SSE API (`scan3115` package). |
| `webapp/` | Bun + TypeScript + React app in Docker: profiles, filters, outputs, destinations, history, MCP server (`src/server/mcp/`). Server layers: `src/server/repos/` (SQLite), `src/server/services/` (logic), `src/server/http/` (Hono routes, OpenAPI). Web UI in `src/web/` (see Web UI code), its tests in `test/web/`. |
| `webapp/docs/PROFILES.md` | User docs for input/output profiles. Update it with `src/server/common-profiles.ts`, filters, formats or destinations. |
| `analyse/` | DEDA tracking-dot analysis service (Python, GPL-3.0-or-later; own `Dockerfile` with a `test` stage, image `ghcr.io/j3lte/dell3115cn-centre-analyse`). The web app talks to it over HTTP via `ANALYSE_ENDPOINT` and never imports from it. |
| `cups/` | CUPS print driver: PCL XL filter + PPD, image filter, supply-level backend, tests. |
| `tools/scan3115.py` | Single-file prototype scanner (verified on hardware); reference for byte sequences. |
| `CHANGELOG.md` | Changes per release; new items go under `## [Unreleased]` (see Workflow). |
| `tools/changelog.py` | Turns `[Unreleased]` into a release in `CHANGELOG.md` and prints the release notes (used by CI). |
| `tools/version.py` | Next release number for the Release workflow (bump or exact version). |
| `tools/ghidra/` | Ghidra headless export script. |
| `re/` | Local reverse-engineering workspace (Dell drivers, Ghidra projects, decompiled code). Gitignored. |
| `.claude/` | Private, gitignored: `local.md` (this machine's setup), superpowers artefacts, reference material, scans. |

## Commands

- Scanner service tests: `cd scanner-service && uv run --python 3.11 --with pytest pytest -q`
- Scanner service in simulator mode: `cd scanner-service && SCAN3115_SIM=1 SCAN3115_SPOOL=/tmp/scan3115 uv run --python 3.11 python -m scan3115`
- Webapp tests: `cd webapp && bun test`; typecheck: `bunx tsc --noEmit -p .`; in its Alpine image with ImageMagick/Tesseract: `docker build --target test webapp`
- Webapp dev: `cd webapp && SERVICE_URL=http://localhost:8765 DATA_DIR=./data bun --hot src/server/index.ts`
- Webapp production bundle (what the image runs): `cd webapp && bun build.ts`, then `bun dist/start.js` (see
  `build.ts`).
- Analyse service tests: `cd analyse && uv run --with pytest pytest -q`; in its container: `docker build --target test analyse`
- CUPS filter tests: `uv run --with pytest pytest cups/tests`
- Release script tests (changelog, version): `uv run --with pytest pytest tools/tests`
- Code index (GitNexus, optional): `gitnexus analyze --skip-agents-md` from the repo root writes a local index to
  `.gitnexus/` (gitignored); `gitnexus status` shows whether it is stale.
- Bun scripts that import project packages must live inside `webapp/`: a script elsewhere makes Bun auto-install its
  own copy of sharp, which hangs.

## Workflow

- **Test-driven development, always.** Write the failing test first, watch it fail for the right reason, then write
  the code that makes it pass, then run the whole suite. Use the `superpowers:test-driven-development` skill when it
  is available. Bug fixes start with a test that reproduces the bug.
- **One branch per feature or bug** (`feat/<topic>`, `fix/<topic>`), never directly on `main`. Worktrees go in
  `.claude/worktrees/`.
- **Use the GitNexus index when it is available.** Explore code and trace call paths with the GitNexus tools, check
  the impact of changing a function or type before editing it, and use its rename for renames across files. Re-run
  `gitnexus analyze --skip-agents-md` after commits or merges when the index reports it is stale.
- **Review after every code change.** When the change is done and the suite is green, run `/simplify` on the changed
  code, run the whole suite again, and only then do the code review (`/code-review` or the
  `superpowers:requesting-code-review` skill) and open the pull request.
- **Commit messages: short and to the point.** Conventional Commits style (`feat(webapp): …`, `fix(cups): …`,
  `docs: …`), a subject line that says what changed, and a body only when the why isn't obvious.
- **CI** (`.github/workflows/ci.yml`) must pass before merging: service, CUPS and release script
  tests (Debian 12 arm64, like the print server), webapp typecheck, the webapp image build with its test stage, and
  the `analyse` job (`docker build analyse`, which runs the tests).
- **Releases**: run the manual *Release* workflow (`.github/workflows/release.yml`: patch, minor or major bump of the
  latest tag, or an exact version; `tools/version.py`) or push a tag `x.y.z` (semver, no `v`) on `main`; CI publishes
  `ghcr.io/j3lte/dell3115cn-centre:x.y.z` and `:latest`, and the same tags of
  `ghcr.io/j3lte/dell3115cn-centre-analyse`. Pushes to `main` publish `:build-<short commit hash>` only.
  After publishing a release, CI renames `## [Unreleased]` in `CHANGELOG.md` to `## [x.y.z](<compare link>)`, puts
  a new empty `## [Unreleased]` (followed by three blank lines) above it, commits that to `main` and creates the
  GitHub release with the same items (`tools/changelog.py`). If `[Unreleased]` is empty, the release lists its
  commits instead.
- **Changelog: every change a user would notice gets an item in `CHANGELOG.md`**, in the same branch as the change: a
  list item (`- …`) under `## [Unreleased]`, newest last, one line or a short wrapped paragraph, written for users of
  the project (what changed for them, not how). Replace the blank lines under the heading with the list. Leave
  internal changes out (refactoring, tests, CI). Never add version headings or edit released sections: CI does the
  release.
- **Screenshots for UI changes**: after changing the web UI, take screenshots of the screens it affects with
  Playwright (the Playwright browser tools) against the dev server with the scanner simulator and test data. Keep
  them small: phone 390 × 844 and desktop 1280 × 800 at device pixel ratio 1, always the light theme, PNG under
  about 150 KB each. They live in `docs/screenshots/` as `<screen>-<phone|desktop>.png`;
  replace the old file of the same screen, and show the important ones in `README.md`. Never show real documents,
  personal data, hostnames or IPs, temporary paths, or secrets (`APP_SECRET`, the MCP key) in a screenshot.
- **Pull requests describe the problem and the solution**: what was wrong or missing, what changed and why, and how
  it was tested (including any hardware test). Link the related TODO item or issue if there is one.

## Web UI code

The web UI (`webapp/src/web/`, React, TanStack Query, Tailwind) is kept in small files:

- **Folders.** `pages/` holds one page component per file (at most a tiny local helper); `components/` one component
  per file, in subfolders by kind (`ui/`, `icons/`, `layout/`, `scan/`, …); `hooks/` one hook per file (`use*.ts`);
  `helpers/` pure functions and constant tables; `lib/` the plumbing (API client and `ApiError`, query client with
  its keys and cache rules, router, socket connection); `types/` shared types. `App.tsx` (the shell: layout,
  navigation, page switch) and `main.tsx` stay at the top. UI tests live in `webapp/test/web/`.
- **Size.** One exported component or hook per file, under about 150 lines. Go over only where splitting reads worse
  (a long flat form, the preview region's pointer handling), and still pull out the hooks and helpers.
- **Memo only where it pays**: list items, components under parents that re-render often (the app shell and the live
  scan view re-render on every socket progress message), costly renders. Not on cheap leaves, components that take
  `children`, or where the props change every render anyway. Parents of a memoized component pass stable props
  (`useCallback`, `useMemo`, module constants), and hooks return stable callbacks.
- **Render tests** (Testing Library + happy-dom) for every component with logic or interaction; layout-only wrappers
  are covered through a component that uses them. A memoized list item or child of an often re-rendering parent gets
  a test that a parent re-render with the same props does not re-render it.
- **happy-dom per test file**, never globally: call `useDom()` from `test/web/setup.ts` at the top of a component
  test file, so the server tests in the same `bun test` run never see `window` or `document`. Radix and user-event
  read `document` when imported: import them (and components that use Radix) dynamically in `beforeAll`, query
  through the `screen` from `setup.ts`, and create the user per test with `userEvent.setup({ document })`.

## Rules

- **No personal or setup-specific information in tracked files**: hostnames, IPs, usernames, serial numbers, service
  tags, MAC addresses, names, deploy targets, tracking-dot decodes. Put it in `.claude/local.md` (gitignored). Use
  placeholders like `<print-server>` / `$PI_SSH` in docs. Exception: the public GitHub owner in repo and image URLs
  (`j3lte/dell3115cn-centre`, `ghcr.io/j3lte/dell3115cn-centre`).
- **No Dell files in the repository**: drivers, decompiled code, PPDs, the ICC profile. Document how to obtain them.
- **Superpowers artefacts live under `.claude/superpowers/`**, never in `docs/`: specs in `.claude/superpowers/specs/`,
  plans in `.claude/superpowers/plans/`, decision logs in `.claude/superpowers/decisions/`, brainstorm companion
  sessions in `.claude/superpowers/brainstorm/`, execution ledgers and review packages in `.claude/superpowers/sdd/`,
  git worktrees in `.claude/worktrees/`. `docs/` is for documentation a user of the project reads.
- Never commit scans or app data: `data/`, `*.pnm`/`*.ppm`/`*.pgm`/`*.pbm` and `.claude/scans/` hold real documents.
- The scanner service must stay Python 3.11 + stdlib + pyusb only, and runnable on 32-bit ARM.
- Only ever touch USB interface 0. Interface 1 belongs to CUPS (`usblp`).
- Every scan path ends with Initialize + Release Unit, including errors and cancel. A stuck reservation blocks the scanner.
- Hardware tests use real paper and can jam the ADF (worn rollers). Keep them short; prefer the simulator.
  If the ADF reports a jam (`02/53`), it persists until the ADF cover is opened and closed.
- Never restart `cupsd` while a job prints (`lpstat -o` must be empty).
- Compose files are named `compose.yml`.

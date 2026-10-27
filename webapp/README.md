# scan-webapp

Phone-first, responsive web app for the Dell MFP Laser 3115cn scanner. It talks to the
[scanner service](../scanner-service/) over HTTP and does everything else:

- **Input profiles**: feeder or flatbed, line art / gray / colour, 75–600 dpi, paper size, automatic orientation,
  default filter.
- **Output profiles**: single- or multi-page PDF, PNG, JPEG, single- or multi-page TIFF; file name template
  (`{date}`, `{time}`, `{datetime}`, `{profile}`, `{input}`, `{n}`, `{page}`); destination: download, folder, SMB,
  FTP/FTPS, Paperless-ngx, Papra or a webhook, each with a **Test** button.
- All profile settings, the common profiles a new installation starts with, formats and destinations:
  [`docs/PROFILES.md`](docs/PROFILES.md).
- **Scan and send** in one tap, or **review** first: rotate, delete, reorder, scan more, filters per scan or per page
  (document, grayscale, black-and-white, brightness, contrast, auto-crop, straighten, sharpen).
- **Sharpen** undoes the scanner's own blur (Richardson-Lucy deconvolution with a blur measured on this scanner with a
  razor-blade edge: Gaussian 0.70 px across, 0.87 px along the feed at 600 dpi; `src/server/pipeline/deconvolve.ts`).
  Light = 5, normal = 10 iterations; colour pages are sharpened through their luminance. Applied to delivered files
  only (previews are downscaled). About 11 s for a full A4 colour page at 600 dpi on an M1, much less at 300 dpi or gray.
- **Flatbed preview** with a region you drag; flatbed + multi-page PDF collects pages until you press Send.
- **History** with re-download, resend (to any output profile) and optional automatic cleanup.
- **Colour calibration**: scan a white sheet once per source (Settings) and colour scans get neutral paper white
  (the scanner leaves white slightly cyan; see [`docs/SCAN-QUALITY.md`](../docs/SCAN-QUALITY.md)).
- **Printer tab**: alerts the printer reports (cover open, tray empty or missing, error codes like 077-300, low
  supplies), toner, belt unit and fuser levels and the page count, from the CUPS queue. Errors that block printing also
  show in the header. **Check now** wakes the printer without printing (a CUPS refresh job) for a current state;
  opening the app does the same when the last read is older than the hours set in Settings → *Printer wake-up* (24 by
  default, or off). Assistants get the same in `scanner_status`, and a fresh report from `refresh_scanner_status`.
- **Printer button**: Scan → Application → JPEG/TIFF/PDF on the panel starts a scan with the profiles set in Settings.
- **Analyse → Tracking dots** (optional, with `ANALYSE_ENDPOINT`): scan a printed page from the glass, or pick a
  colour page from History, and see the printer's yellow tracking dots found and decoded with DEDA by the separate
  [analyse service](../analyse/). Glass scans for it are temporary and never show in History. See
  [`docs/ANALYSE.md`](../docs/ANALYSE.md).
- Live connection status: the app shows when the scanner service or the printer is off and reconnects by itself.

No login: run it on a trusted network.

## Run

Use the published image `ghcr.io/j3lte/dell3115cn-centre` with the `compose.yml` from "Getting started" in the
[repository README](../README.md#getting-started).

The `compose.yml` in this folder is for development: it builds the image from source (the build runs the full test
suite first):

```sh
export SERVICE_URL=http://<print-server>:8765 APP_SECRET=$(openssl rand -base64 32)
mkdir -p data && sudo chown 1000:1000 data          # the container runs as uid 1000
docker compose up -d --build
```

Settings (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `SERVICE_URL` | `http://localhost:8765` | Scanner service URL |
| `DATA_DIR` | `/data` | SQLite database (`scan-webapp.sqlite`), scans and outputs |
| `PORT` | `8080` | HTTP port |
| `APP_SECRET` | — | Encrypts destination passwords/tokens. If unset, a secret is generated, saved in `DATA_DIR/app-secret`, printed in the log and shown in Settings — copy it into `APP_SECRET`. Changing it makes stored credentials unreadable (profiles then ask to re-enter them). |
| `TZ` | `UTC` | Time zone for file names (`{date}`, `{time}`) |
| `PRINTER_URI` | `ipp://<SERVICE_URL host>:631/printers/Dell_MFP_Laser_3115cn` | CUPS queue to read the printer's state from (supplies, alerts, page count) (IPP Get-Printer-Attributes); `off` hides them |
| `ANALYSE_ENDPOINT` | — | URL of the [analyse service](../analyse/), e.g. `http://analyse:8770`. Turns on the *Analyse* section (tracking dots); unset hides it and `/api/analyse/*` answers 404. See [`docs/ANALYSE.md`](../docs/ANALYSE.md). |
| `SRGB_ICC` | colord's `sRGB.icc` (in the image) | sRGB profile used for the colour transform |
| `DEVICE_ICC` | `assets/dell3115cn.icm` | The scanner's colour profile (Dell's; not included, see [`assets/README.md`](assets/README.md)). Without it colour scans have a magenta cast; the log warns at startup. |

**Folder destinations** write inside the container: mount the target directory and use the container path in the
profile. **The colour profile:** mount it at `/app/assets/dell3115cn.icm` (read-only) or point `DEVICE_ICC` at it.

## AI assistants (MCP)

The app serves an MCP endpoint at `/mcp/` (Streamable HTTP, stateless), so an assistant such as Claude can check the
scanner, scan, look at pages and download results, and do everything the UI can (profiles, history, settings).

- **Access:** on first start the app generates a key (a UUID) and turns MCP on. Settings → *AI assistants (MCP)* shows
  the endpoint and key, lets you switch MCP off, regenerate the key, and copy a ready-made client setup, e.g.
  `claude mcp add --transport http scanner http://<host>:8080/mcp/ --header "Authorization: Bearer <key>"`.
  Clients send the key as `Authorization: Bearer <key>`; that key is the guard (requests carrying another site's browser
  Origin are refused too, but that is no protection against DNS rebinding).
  The Settings page itself has no login, so anyone who can open the app can see the key.
- **Scans:** assistants choose every setting themselves (source, mode, dpi, area, filters including sharpening, 8 or 16
  bits per colour channel). Their scans are **temporary** (deleted after 60 minutes without use, configurable) unless
  stored; stored ones appear in History with an "MCP" label and can be sent or downloaded from there. Nothing is sent
  to a destination unless the assistant is asked to.
- **Files:** `get_download_links` returns one link per file (`/files/<id>?key=…`); each works for one GET and expires
  after 15 minutes. Switching MCP off or regenerating the key invalidates all links.
- **Seeing pages:** `page_image` (≤ 1568 px) and `zoom` (a region at full resolution) return images to the assistant;
  `preview` shows the whole glass.
- Stored passwords and tokens of output profiles are never returned (they come back masked).

## API

The web UI uses a REST API under `/api`, described in OpenAPI 3.1:

- `/api/docs`: interactive reference (served by the app, works offline).
- `/api/openapi.json`: the machine-readable description, e.g. to generate a client.

Writes (POST, PUT, PATCH, DELETE) send their body as `application/json`. A write from another site's origin, or
with a body of another type, gets 403; one without an Origin header (curl, scripts) is fine. Like the rest of the app, the API has no login.

## Development

```sh
bun install
bun test                                   # unit + integration tests (some skip without tesseract/ImageMagick)
docker build --target test .               # full suite in the Alpine image
# scanner simulator + dev server (see ../CLAUDE.md for the simulator command)
SERVICE_URL=http://localhost:8765 DATA_DIR=./data bun --hot src/server/index.ts
# the production bundle the image runs (see build.ts)
bun build.ts && SERVICE_URL=http://localhost:8765 DATA_DIR=./data bun dist/start.js
# with the Analyse section: run the analyse service (cd ../analyse && docker compose up --build) and add
# ANALYSE_ENDPOINT=http://localhost:8770
```

Colour pages get the scanner's ICC profile (`DEVICE_ICC`, default `assets/dell3115cn.icm`) applied, then sRGB. The scanner's raw white point
differs slightly per resolution (magenta tint at 150 dpi, cyan tint at 300 dpi on the white lid); the "document" filter
normalises the background.

Server code is layered: `src/server/repos/` (SQLite access), `src/server/services/` (logic) and `src/server/http/`
(Hono routes and OpenAPI schemas); the UI calls the API through a typed Hono client and TanStack Query.

Screenshots: in the [main README](../README.md).

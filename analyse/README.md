# analyse

Service that looks for the yellow tracking dots a colour laser printer adds to every page, in a scanned page, and
decodes them with [DEDA](https://github.com/dfd-tud/deda). Used by the web app's *Analyse* section (set the web app's
`ANALYSE_ENDPOINT` to this service, e.g. `http://<host>:8770`).

## Licence

Licensed GPL-3.0-or-later (see `LICENSE`), because it uses DEDA. **The image contains DEDA, which is GPLv3**; the
image carries the OCI annotation `org.opencontainers.image.licenses=GPL-3.0-or-later`. The rest of the repository is
Apache-2.0 and does not import from here.

## Run

```sh
cd analyse && docker compose up --build
```

`docker build .` runs the test suite first (stage `test`); the runtime image is only produced if it passes. The image
is Alpine 3.22 with Alpine's numpy, SciPy, OpenCV, Pillow and ReportLab packages, and DEDA 2.0b4 plus PyPDF2 3.0.1
from pip without their dependencies (DEDA would otherwise pull in the non-headless `opencv-python` and `eel`, which it
does not need for decoding). It runs as a non-root user and listens on port 8770 (`PORT` to change). It logs one
line per request to stdout (`LOG_LEVEL`: `debug`, `info`, `warn` or `error`; default `info`), never the image or its
results.

Memory: one page is analysed at a time; a 600 dpi A4 page peaks at about 0.8 GiB (8-bit input) to just under 1 GiB
(16-bit input). Give the container 1.5 GiB (`mem_limit: 1536m`); 1 GiB is too tight.

## API

- `GET /health` -> `200 {"ok": true, "service": "analyse", "analyses": ["deda"]}`
- `POST /deda/?dpi=600` with the page image as the body (PNG 8 or 16 bit, PNM, TIFF or JPEG; colour; up to 256 MiB).
  `dpi` is the scan's resolution, 150 to 1200 (default 600; 600 works best). Answers:
  - `200` with the report: `found` (a dot grid was detected), `dots` (dots found), `gridScore` (how clear the grid
    is; found needs more than 3), `dpi`, `paperWhite` (`[r, g, b]`), `decode` (DEDA's decode, only when found and
    DEDA could decode it, else `null`), `decodeError` (DEDA's message when it could not, else `null`), `closeOrigin`
    (`[y, x]` of the close-ups, px, or `null`) and `images` (base64 PNG: `overview`, and when there are dots
    `closeRaw`, `closeEnhanced`, `closeYellow`);
  - `400 {"error": "invalid", "message": ...}` for a bad `dpi`, a missing or empty body, or an unreadable image;
  - `413 {"error": "too_large"}` for a body over 256 MiB (decompressed size, see below);
  - `415 {"error": "unsupported_encoding"}` for a `Content-Encoding` other than `gzip` or `identity`.

Compression: send `Accept-Encoding: gzip` and every JSON response of 1 KiB or more comes back gzip-compressed
(`Content-Encoding: gzip`, `Vary: Accept-Encoding`). A request body may be gzip-compressed too
(`Content-Encoding: gzip`); the 256 MiB limit then applies to the decompressed size, and a corrupt body answers
`400 {"error": "invalid", "message": "bad gzip body"}`.

Requests are served one at a time. Nothing is stored and request content is never logged.

## Tests

```sh
cd analyse && uv run --with pytest pytest -q
```

The tests use generated pages only (fake serial `123456`), never real scans.

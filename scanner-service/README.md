# scan3115 — scanner service

Small Python service that owns the Dell MFP Laser 3115cn scanner (USB `413c:5607`, interface 0) and exposes
scanning over HTTP and server-sent events. Runs on the machine the printer is plugged into (e.g. a Raspberry Pi
print server). Printing through CUPS keeps working: CUPS uses interface 1.

- Python 3.11+, stdlib + [pyusb](https://pyusb.github.io/pyusb/) only (Debian: `python3-usb`). Works on 32-bit ARM.
- Survives the printer being switched off and on: it reports `printer: "off"` and picks the device up again.
- One scan at a time. Pages are written to a spool directory as PNM and removed after an hour (and at startup).
- On stop (SIGTERM) a running scan is cancelled and the scanner released before exit.
- Protocol details: [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md).

## Install (Debian / Raspberry Pi OS)

```sh
rsync -a scanner-service/ <user>@<pi-host>:scan3115/
ssh <user>@<pi-host> 'cd scan3115 && sudo ./deploy/install.sh'
curl http://<pi-host>:8765/api/status
```

`install.sh` installs `python3-usb`, creates the system user `scan3115` (group `scanner`), copies the package to
`/opt/scan3115`, installs a udev rule giving group `scanner` access to the device, and enables `scan3115.service`.
Re-run it to update. Logs: `journalctl -u scan3115 -f`.

## Configuration

Environment variables (put overrides in `/etc/default/scan3115`):

| Variable | Default | Meaning |
|---|---|---|
| `SCAN3115_PORT` | `8765` | HTTP port |
| `SCAN3115_BIND` | `0.0.0.0` | Bind address |
| `SCAN3115_SPOOL` | `/var/lib/scan3115` | Page spool directory |
| `SCAN3115_SIM` | — | `1` = simulated scanner (no USB, for development) |
| `SCAN3115_SIM_PAGES` | `3` | Pages in the simulated feeder (refilled after each batch) |
| `SCAN3115_SIM_JAM` | — | Simulate one jam at `page:line` (clears after `SCAN3115_SIM_JAM_CLEAR_S`, default 5 s) |
| `SCAN3115_CORS_ORIGIN` | — | Send `Access-Control-Allow-Origin` with this value. Off by default: the webapp calls the service server-side |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn` or `error` (`SCAN3115_LOG` still works). Logs go to stdout. |

There is no authentication: run it on a trusted network only.

## API

All JSON. No CORS headers unless `SCAN3115_CORS_ORIGIN` is set.

| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/api/status` | `{"service":"scan3115","version","printer":"off"\|"idle"\|"scanning"\|"jammed","paper_in_feeder":bool,"job":id\|null}` | |
| GET | `/api/events` | SSE: `status` (snapshot on connect, then changes), `button` `{"button":1,"target":"application","format":"jpeg"\|"tiff"\|"pdf"}`, `: ping` every 15 s | |
| POST | `/api/scans` | 202 `{"id"}`. Body: `{"source":"flatbed"\|"adf","mode":"lineart"\|"gray"\|"color","dpi":75\|100\|150\|200\|300\|400\|600,"area_mm"?:[x,y,w,h],"paper"?:"a4"\|"letter"\|"legal","threshold"?:0-255,"depth"?:8\|16}` (`depth` 16 only with `color`) | 400 `invalid`, 409 `busy`, 413 `too_large` (body over 64 KiB), 503 `printer_off` |
| GET | `/api/scans/{id}` | `{"id","state":"running"\|"done","pages":[{"n","width","height","mode","depth","bytes"}],"result":null\|{"reason","message","pages"}}` | 404 |
| GET | `/api/scans/{id}/events` | SSE: `page` `{"n","width","height","mode"}`, `done` `{"reason","message","pages"}`; replays, closes after `done` | 404 |
| GET | `/api/scans/{id}/pages/{n}` | PNM (`P4`/`P5`/`P6`; 16-bit colour is `P6` with maxval 65535; a page shorter than requested has its height padded with spaces, e.g. `P5\n2480  300\n255\n`); streamed gzip when the request accepts it (`q=0` honoured) | 404 |
| POST | `/api/scans/{id}/cancel` | 202 | 404 |
| DELETE | `/api/scans/{id}` | 204 | 404 |

`done.reason`: `complete`, `feeder_empty` (no paper at all), `jam` (pages before the jam are kept; message says
"Paper jam after page N — open and close the ADF cover"), `cancelled`, `error` (e.g. `printer disconnected`).
The feeder scans until it is empty. Pages are never rotated and colour pages are raw device RGB: apply the device ICC
profile (Dell's `dell3115cn.icm`, see [`../webapp/assets/README.md`](../webapp/assets/README.md)) for neutral colours.

The panel's **Scan → Application → <format>** sends a `button` event; the printer then shows "Please wait"
until a scan is started.

## Development

```sh
uv run --python 3.11 --with pytest pytest -q                                   # tests
SCAN3115_SIM=1 SCAN3115_SPOOL=/tmp/scan3115 uv run --python 3.11 python -m scan3115   # simulator
```

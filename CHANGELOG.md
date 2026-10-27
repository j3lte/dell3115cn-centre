# Changelog

Notable changes per release. Releases are tagged `x.y.z`; each heading links to the changes since the previous one.

## [Unreleased]

- The printer no longer wakes up every 6 hours to report its state (warm-up noise, beeps). The web app wakes it when
  it is opened and the last check is older than the hours set in Settings → *Printer* (24 by default, or off); the
  Printer tab shows when the printer was last read. Assistants can ask `scanner_status` for a fresh report with
  `wake: true`. On an existing print server, disable the timer: `sudo systemctl disable --now dell3115cn-supplies.timer`.

## [1.0.0](https://github.com/j3lte/dell3115cn-centre/commits/1.0.0)

- Scanner service for the print server: flatbed and feeder, line art, gray and colour at 75–600 dpi, 8- or 16-bit
  colour, scan regions and the panel's Scan button, over HTTP and server-sent events; simulator mode for development.
- Web app: input and output profiles, flatbed preview with region selection, automatic page orientation, filters
  (document, grayscale, black and white, brightness, contrast, auto-crop, straighten, sharpen), review tray, PDF, PNG,
  JPEG and TIFF, delivery to download, folder, SMB, FTP, Paperless-ngx, Papra or a webhook, and history.
- Web app MCP server at `/mcp/`: AI assistants can check the scanner, scan, look at and zoom into pages, get one-time
  download links, and manage profiles and history.
- CUPS print driver: PCL XL rendered by Ghostscript (with correct two-sided printing), a JPEG-preserving image filter,
  and toner, belt unit and fuser levels, printer alerts (covers, trays, error codes) and the page count in CUPS.
- Web app image for linux/amd64 and linux/arm64 on GitHub Container Registry.
- Documentation of the USB scan protocol, the printer, scan quality and the reverse engineering.
- Input profiles can scan in 16-bit colour.
- History can send a cancelled scan that has pages, e.g. one discarded in the review tray.
- Web app Printer tab: printer alerts, toner, belt unit and fuser levels and the page count; printing errors also show
  in the header. *Check now* wakes the sleeping printer without printing and reads its state.
- Web app theme setting per device: System (default), Light or Dark.
- Colour calibration in Settings: scan a white sheet once (flatbed and feeder separately) and colour scans come out
  with neutral white paper instead of a slight cyan cast.
- The web app describes its REST API: an interactive reference at /api/docs and the OpenAPI description at
  /api/openapi.json.
- The sidebar shows the printer's name and a drawing of it instead of "Scan".

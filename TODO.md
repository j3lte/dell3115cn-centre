# TODO

- [ ] Confirm the order of cyan, magenta and yellow in the device-ID status record once their levels differ (compare
      with the printer's web page or panel; black, belt unit and fuser are confirmed); set `DELL3115_TONER_ORDER` if
      different.
- [ ] Feeder: test a scan window taller than the paper (Legal window, A4 paper) on hardware.
- [ ] Feeder: hardware check of the scanner-service fixes (pages written once with a padded PNM height, "paper in
      feeder" updated during a scan): a short multi-page feeder scan in gray and colour, opened in the web app.
- [ ] Feeder colour calibration on hardware (Settings → Colour calibration → Feeder, one white A4 sheet).
- [ ] Printer error codes: only 077-300, 005-301 and 005-302 have their own text; record others (jams, paper size) as
      they happen and add them to `ERRORS` in `cups/backend/dell3115cn-supplies.py`.
- [ ] PCL XL: measure a full-page JPEG photo and a long multi-page PDF on a Pi Zero 2 W for time and memory.
- [ ] If phones send raster (URF/PWG) at 600 dpi, advertise 300 dpi rasters instead.
- [ ] Authentication for the web UI and administration (deferred; the MCP key is visible to anyone who can open Settings).
- [ ] MCP tool for the DEDA tracking-dot analysis.
- [ ] Remove the retired SMB destination type completely in a later version (its `retired` smb entry, label, schema
      enum value and the read-only support for old SMB profiles), once existing installs have had a release to switch
      their SMB profiles to another destination.

# Printer: Dell MFP Laser 3115cn

Analysed on a Raspberry Pi Zero 2 W running Debian 12 (64-bit).

## Identity

| Field | Value |
|---|---|
| Model | Dell MFP Laser 3115cn (color laser multifunction, ~2006–2008) |
| USB ID | `413c:5607` (Dell Computer Corp.) |
| USB | 2.0 high-speed, `bcdDevice 1.00` |
| Functions | Print, copy, fax, scan (flatbed + ADF, 600 dpi optical) |
| Network | Has its own Ethernet port ("cn"): a web page (EWS) with status and supply levels, SNMP (Printer MIB), LPD and raw port 9100. This setup prints and scans over USB; the network port only served to check the supply levels. |
| OEM | Fuji Xerox: the NIC's MAC address has the Fuji Xerox OUI `08:00:37` (status page), plus `DL*` PPD option names. |

IEEE 1284 device ID (from the CUPS USB backend):

```
MFG:Dell;CMD:PJL,RASTER,DOWNLOAD,TIJL,SCJL,ECHO,PCLXL,PCL,HBPL,POSTSCRIPT;
MDL:MFP Laser 3115cn;DES:Dell MFP Laser 3115cn;CLS:PRINTER;
```

`SCJL` in the command set might be a scan job language. That is a guess, not verified.

## USB interfaces

The device exposes two interfaces:

| Interface | Class | Endpoints | Kernel driver | Purpose |
|---|---|---|---|---|
| 0 | `255` Vendor Specific (subclass 0, protocol 255) | EP1 OUT bulk 512, EP2 IN bulk 512, EP5 IN interrupt 8 | none | **Almost certainly the scanner** |
| 1 | `7` Printer (subclass 1, protocol 2 bidirectional) | EP3 OUT bulk 512, EP4 IN bulk 512 | `usblp` | Printing (CUPS uses `interface=1`) |

The scanner interface is unclaimed, so a userspace program can open it with libusb without disturbing printing.

## Printing (works)

- CUPS queue: `Dell_MFP_Laser_3115cn`, shared, device URI
  `usb://Dell/MFP%20Laser%203115cn?serial=<serial>&interface=1`
- Driver: PCL XL rendered on the print server by Ghostscript (`cups/ppd/Dell-MFP-Laser-3115cn-pxl.ppd`
  + `cups/filter/dell3115cn-pxl`), see "PCL XL driver" below. Previously: Dell's own PostScript PPD `DL3115CN.PPD`,
  `*NickName: "Dell MFP Laser 3115cn v3015.103 PS"`, PostScript level 3, 600 dpi, color (not included: Dell copyright; see `docs/REVERSE-ENGINEERING.md`).

## Scanning

No SANE backend or Linux driver exists for this scanner (SANE's `scanimage -L` finds nothing; Dell only shipped
Windows TWAIN/WIA drivers). Its USB protocol was reverse-engineered from Dell's WIA driver and works:
see [`PROTOCOL.md`](PROTOCOL.md).

## Sources

- [Dell community: 3115cn network scanning with Linux (2007, unsolved)](https://www.dell.com/community/Linux-General/Dell-3115cn-Network-Scanning-with-Linux/td-p/2494636)
- [VueScan: Dell Laser MFP 3115cn driver page](https://www.hamrick.com/de/vuescan/dell-laser-mfp-3115cn-treiber.html)
- [USB ID database, vendor 0x413C](https://the-sz.com/products/usbid/index.php?v=0x413C)

## CUPS PPD analysis

Compared three PPDs: Dell's original `DL3115CN.PPD` (identical in the A09 and A10 Windows PostScript drivers, PS
driver 4.2.1.34/35), a community-edited version used on the print server ("Secure Print PPD for CUPS"), and the
installed copy (= the edited one plus `InstalledMemory 384Meg` and `Option3` duplexer = True). Dell's PostScript
rendering plugin `dlpsc3fr.dll` was decompiled to see what Dell's driver actually sends. `cupstestppd`: PASS for all.

**What the edited PPD changes, and verdict:**

| Change | Verdict |
|---|---|
| `ManualFeed` Boolean replaced by `InputSlot` choices `AutoSelect` (default, empty code) and `BypassTray` (= Dell's `ManualFeed true` code); A4 defaults; `cupsVersion`, UTF-8 | Fine, and friendlier to IPP clients. Dell's envelope/special-media constraints are kept via the `InputSlot` constraints. |
| Secure Print (`@PJL SET HOLD=STORE`, `HOLDTYPE=PRIVATE`, `HOLDKEY="…"`, `USERNAME`, `JOBNAME`) with 5 fixed PINs | **Correct.** Dell's plugin encodes the PIN as `base64(PIN XOR "pfsw")` — the key `pfsw` and a base64 table are in both `dlpsc3fr.dll` and `dlpsc3fu.dll`, and all five keys in the PPD decode to their PIN with it. Limitation: only those five PINs. Dell uses `HOLDENCRYPTKEY` instead when the printer reports an encryption capability; the PPD always uses `HOLDKEY` (untested on hardware). |
| Colour density options (`/Cyan/Low 0/Custom/ProcSet findresource/setcolorbalance get exec`, 4 colours × Low/Middle/High) | Format matches Dell's plugin exactly (`/%s/%s %d` + `%s/Custom/ProcSet findresource/%s get exec`). **But** Dell only sends them when "Adjust Color Balance" is on; with this PPD CUPS sends all 12 (value 0) on every job, which may override density adjustments made on the printer panel. |
| `DLColorBalanceAdjustment` sends `true|false/Custom/ProcSet findresource/setcolorbalance get exec` | **Wrong**: Dell never calls `setcolorbalance` with a boolean (it expects `/Colour /Band n`). CUPS wraps PPD code in `stopped`, so this most likely fails silently on every job. Should be `""` (UI only). |

## Printing speed

Measured the CUPS chain on the Pi Zero 2 W and macOS (no printing) with a 3000×2000 test photo:

| Input | Path | PostScript sent to printer | Time to produce |
|---|---|---|---|
| PDF with JPEG inside | Pi: `pdftopdf → pdftops` | 1.06 MB (JPEG kept, `DCTDecode`) | 0.6 s |
| bare JPEG (phones/AirPrint, `lp photo.jpg`) | Pi: `imagetopdf → pdftops` | **22.9 MB** (JPEG decoded to raw RGB, ASCII85) | 7.3 s |
| same, `pdftops-renderer=gs` / `pdftocairo` | Pi | 23.1 MB / 14.0 MB | 18 s / 15 s |
| JPEG or PDF printed from macOS ("Generic PostScript Printer" queue) | Mac `cgpdftops`, sent as PostScript | 1.06 MB | 0.1–0.4 s |
| PNG / lossless image (any client) | Mac or Pi | **~23 MB per 6 MP** | ~8 s on the Pi |

Findings: bare JPEGs lose their compression in `imagetopdf`; lossless images are always huge in PostScript; past
jobs from the Mac arrived as client-generated PostScript (one was 115 MB). The Mac queue is set up as
"Generic PostScript Printer", so it also lacks every Dell option. The printer's own processing time for 1 MB vs
23 MB jobs is not measured yet (needs test prints).

**Fixes applied** (files in [`cups/`](../cups/)): the PPD fix (colour balance UI-only, densities default to
"Printer setting") and the `imagetopdf-img2pdf` filter: a bare JPEG now becomes 1.05 MB of PostScript in 1.9 s
instead of 22.9 MB in 9.5 s (page size and copies still honoured). Lossless images (PNG) are unchanged.

**Printer-side timing** (full-page colour photo, A4, "High Speed" mode, timed from `lp` to paper):

| Test | PostScript size | CUPS hand-over (printer paces the USB transfer) | Page out |
|---|---|---|---|
| JPEG, printer idle | 1.16 MB | 58 s | ~1.5 min (≈30 s warm-up) |
| JPEG, printer warm | 1.16 MB | 56 s | ~1 min |
| PNG, printer warm | 25.8 MB | 98 s | ~1.7 min |

The printer's PostScript interpreter needs about a minute per full-page colour photo however compact the data;
lossless images add ~40 s. Pages that poppler has to rasterise are far worse (6+ minutes); this led to the switch to
PCL XL, see "PCL XL driver" below.

## Firmware

Read from the printer over USB (PJL `INFO` and PostScript `currentsystemparams`, no page printed):
PostScript `version` 3015.103, `revision` 20060726, `InstalledRam` 128 MB (the installed PPD said 384 MB — corrected
to `128Meg`; the option has no effect on output), page count 66,065, input trays: Tray 1 + bypass (SMH), duplexer present.
The scanner's Inquiry firmware string is `200809111016`.

Dell's newest firmware is **A04** (`R201964.EXE`, posted 2012-05-29, MD5 `039821b6cda0659be2948e50d413e56f`):
controller image `Dell_3115cn_ESS080919.prn` (`RELEASE=200809190845`, `MAIN=200806271041`,
`AIOCMAIN=200809111016`, `PSPS=200607271136`, …) and engine image `Dell_3115cn_MCU050900.bin` (`MCUFIRM=05.09.00`),
both PJL `ENTER LANGUAGE=DOWNLOAD` jobs sent by Dell's Windows tool `dellfwup.exe`.
**Confirmed on A04** by the panel's "System Settings" report: Firmware Version 200809190845 (= A04 `RELEASE`),
Engine Version 05.09.00 (= `MCUFIRM`), IPS Version 200809111016 (= `AIOCMAIN`), PCL5/PCL6 200806271042, PostScript
200607271136 / 3015.103, Boot 200606081411, IIT 200703162011, duplexer 02.10.00, network firmware 9.28. Counters at the
time: 66,065 impressions (43,821 colour, 22,244 black), almost all A4. The report shows no toner levels.

## Network printing setup

- `cups-browsed` is disabled on the print server: it re-imported the server's own shared queue as a duplicate
  (`…_printserver`). Advertising the shared queue is done by `cupsd` itself, so nothing is lost.
- The queue is advertised as `_ipp._tcp` / `_ipps._tcp` with subtypes `_universal` (AirPrint, iOS/macOS) and `_print`
  (IPP Everywhere / Mopria, Android's Default Print Service), plus `_printer._tcp`. Offered: colour/monochrome,
  one-/two-sided, A4/A5/B5/Letter/Legal/Executive/envelopes.
- Phones normally send PDF (or JPEG for photos), both on the fast path. If a client sends raster (`image/urf`,
  `image/pwg-raster`, advertised at 600 dpi), the Pi converts ~100 MB per colour page (`rastertopdf → pdftops`) —
  advertise 300 dpi rasters if that ever happens.
- macOS: add the printer as an IPP printer (IPP Everywhere / Secure AirPrint): the Mac sends PDF and the server's
  driver does the rest. "Generic PostScript Printer" bypasses the server driver; don't use it.

## Status record: supplies, alerts, page count

The printer answers no supply queries over PJL (`INFO SUPPLIES/TONER/CONSUMABLES` → `?`) or PostScript (nothing in
`statusdict`, system params or Dell's `Custom` procset: `curdtsmode setprocessmode currentprocessmode recordlog
setcolorbalance gethalftonename`). Dell's Windows language monitor `dlxbazil.dll` (decompiled) reads `TonerRemain`
and `CRURemain` from a binary status record, which the printer publishes base64-encoded in the `STS:` field of its
IEEE 1284 device ID (readable on Linux with `LPIOC_GET_DEVICE_ID` on `/dev/usb/lp0`, or sysfs `ieee1284_id`).

Decoded record (72 bytes, offsets in the decoded STS):

| Offset | Meaning |
|---|---|
| 0x02 | Main state: `0x13` asleep (power saver), `0x19` ready, `0x14` printing, `0x10` an error that stops printing (front cover), `0x16` a scanner-side alert (ADF cover, scanner lid). |
| 0x03 | Sub-state, e.g. `0x06` then `0x05` while waking up, `0x00` printing, `0x01` ready. |
| 0x05, 0x06–0x07 | The error code shown on the printer's display, XXX-YYY: XXX, then YYY big-endian. `ff 00 ff` = none. Seen: `077-300` front cover open, `005-301` ADF top cover open, `005-302` scanner cover open. |
| 0x0c, 0x0e, 0x10, 0x12 | Four toners, cyan, magenta, yellow, black: level in percent, each followed by `0x03`. `0x7f` = unknown (all supplies read `0x7f` while the front cover is open). |
| 0x14 | Belt unit, level in percent (followed by `0x03`). |
| 0x16 | Fuser, level in percent. |
| 0x18 | Bit `0x10`: paper in the multi-purpose tray. |
| 0x1e | Bit `0x20`: tray 1 inserted; bit `0x10`: tray 1 has paper. |

Checked against the printer's own reports over its network port, the web page (EWS) and the SNMP supplies table
(`prtMarkerSuppliesDescription` / `…Level` / `…MaxCapacity`), at a moment they read cyan, magenta, yellow 80 %,
black 40 %, belt unit 30 %, fuser 40 %: the record held 80, 80, 80, 40, 30, 40 at these offsets. Dell's
`dlxbazil.dll` reads the toners from 0x0e and a "CRU" (drum) from 0x16; read that way the levels are wrong for this
model (yellow shows black's level, black the belt unit's, and the "drum" is the fuser; the 3115cn has no separate
drum). Cyan, magenta and yellow were equal at the time, so their order follows SNMP's but is not proven
(`DELL3115_TONER_ORDER` changes it).

The state, error-code and tray bytes were found the same way: one change at a time on the printer (front cover, tray
1 out, tray 1 empty, paper in the multi-purpose tray, ADF cover, scanner lid, a print job), each compared with the
printer's SNMP alerts (`prtAlertDescription`, e.g. "077-300:Front cover is open."), cover and input tables. The same
record is also in SNMP (the PWG port-monitor MIB carries the 1284 device ID). **In deep power saver the print engine
sleeps** and the record (and SNMP and the web page) keep the last state: an opened cover or refilled tray only shows
once the engine wakes. A job wakes it, and so does the PostScript page-count query below, which prints nothing: within
a second the record reads `0x19` (awake) and the sensors are current (checked with tray 1 pulled out while asleep).
PJL `INFO STATUS` and an empty PJL job don't wake it; `INFO STATUS` does tell: `CODE=35078` asleep, `10001` ready.
Power saver itself can't be changed over PJL (`POWERSAVE` and `POWERSAVETIME` are read-only).

**Page count.** PJL `INFO PAGECOUNT` answers `PAGECOUNT=0`; the PostScript interpreter has the real count:
`currentsystemparams /PageCount get` (the same as SNMP's `prtMarkerLifeCount`), read over the printer interface
without printing. PJL `INFO STATUS` returns the panel's text. Careful: with "PS Error Report" on (the default), a
PostScript error in such a query prints an error page.

`cups/backend/dell3115cn` (a wrapper around the usb backend, device URI `dell3115cn:usb://…`) reports all this to
CUPS before and after every job: levels as `marker-*` attributes (macOS "Supply Levels", iOS), alerts as standard
`printer-state-reasons` (`door-open-error`, `cover-open-error`, `other-error`, `input-tray-missing-warning`,
`media-empty-warning`, `toner-low-warning`, `marker-supply-low-warning`) with their texts and error codes in
`printer-alert-description` (CUPS clears the `INFO:` message when a job ends, but keeps that attribute), and after a
job the page count in `marker-message` ("66098 pages printed"). A job titled `supply-refresh` only updates them; it
sends the page-count query first, so the printer wakes up and the state it reports is current. CUPS stamps each
update in `marker-change-time`, so clients can tell how old the state is.

Nothing sends refresh jobs on a timer: waking the printer means a warm-up with fan, motors and a beep, and a read
without waking adds nothing (the sleeping printer keeps reporting its last state, and CUPS keeps the levels in
`printers.conf` across restarts). The web app sends a refresh when it is opened and `marker-change-time` is older
than its `printerWakeHours` setting (24 hours by default), and on *Check now*.

Because of the CUPS 2.4.2 workaround below, the backend sends `marker-names` only once. To change the names (as
when the belt unit and fuser replaced the "imaging drum"), stop cupsd while no job is printing, remove the
`Attribute marker-*` lines from `/etc/cups/printers.conf`, start cupsd and send a `supply-refresh` job.

Clients keep their own copy: a macOS queue only copies the server's levels while it sends a job (a new queue shows
"information not available" until then). A refresh without printing, from the client:
`printf '\n' | lp -d <queue> -t supply-refresh -o raw` — the server's backend recognises the title and prints nothing.

**Known issue: macOS "Supply Levels" still says "not available"** (macOS 26.6, queue added with `lpadmin -m everywhere`).
Verified: the server answers the Mac's `Get-Printer-Attributes` (captured on the wire) with correct `marker-*` and
standard `printer-supply` values (`colorantname=cyan` etc.), the Mac's local queue holds the levels, and dropping the
fifth (non-toner) entry changes nothing. Fixed along the way: CUPS 2.4.2 appends another `printer-supply-description` on every
`ATTR: marker-names=` (the script now sends names only when missing), and `marker-colors` use PWG colour names
(CUPS copies them into `colorantname`). The remaining cause is inside macOS PrintCore; not pursued.
The levels are visible via IPP (`ipptool … get-printer-attributes.test`) and the CUPS printer page.
Control test: CUPS's reference IPP Everywhere printer (`ippeveprinter`, standard `printer-supply`, no CUPS sharing)
also shows "not available" in macOS 26.6 Supply Levels, and macOS sends no SNMP — so it is macOS behaviour, not the
CUPS setup. Switching to a Printer Application (PAPPL / `ps-printer-app`) would not change it.
- Android (Default Print Service) verified: sends `Validate-Job` + `Print-Job` with PDF (fast path).
  One attempt was rejected with `client-error-charset-not-supported` / `Unsupported character set "successful-ok"`:
  the phone put a status string from the previous response into `attributes-charset` (client bug). The retry was
  accepted but printed a PostScript error page (`ioerror`, `OFFENDING COMMAND: image`): cupsd was restarted while the
  job was being sent, and the restarted job landed on the half-sent one. The same page also took 6+ minutes on the
  PostScript queue, see "PCL XL driver".

## Network port (SNMP and web page)

The printer has its own Ethernet port. This setup doesn't need it (printing and scanning go over USB), but when it is
connected it is a useful reference for the USB status record, since it shows the printer's own view. Read-only, SNMP v1
with the default community `public`:

| What | Where |
|---|---|
| Supplies: names, maximum, level | Printer MIB `prtMarkerSuppliesDescription` / `…MaxCapacity` / `…Level` (`1.3.6.1.2.1.43.11.1.1.6/8/9`) |
| Alerts, e.g. "077-300:Front cover is open." | `prtAlertDescription` (`1.3.6.1.2.1.43.18.1.1.8`) |
| Covers (5 open, 6 closed): front, ADF top, scanner | `prtCoverStatus` (`1.3.6.1.2.1.43.6.1.1.3`) |
| Trays: capacity, level (0 empty, -3 some paper) | `prtInputMaxCapacity` / `prtInputCurrentLevel` (`1.3.6.1.2.1.43.8.2.1.9/10`) |
| Page count | `prtMarkerLifeCount` (`1.3.6.1.2.1.43.10.2.1.4`) |
| Panel display text | `prtConsoleDisplayBufferText` (`1.3.6.1.2.1.43.16.5.1.2`) |
| State (idle, printing, other) | Host Resources `hrPrinterStatus` (`1.3.6.1.2.1.25.3.5.1.1`) |
| The USB device ID, including the `STS:` record | PWG port-monitor MIB (`1.3.6.1.4.1.2699.1`) |

About 3,000 more values sit under Xerox's enterprise number (`1.3.6.1.4.1.253.8`, Fuji Xerox made this printer). The
web page (`http://<printer>/ews/index.htm`) shows status (toner, fuser, belt unit, trays, covers), events, the page
count per paper size, every panel setting ("Printer Settings Report") and the job list. It has no password by default
and LPD (515) and raw printing (9100) are open too, so on a shared network keep the cable out or the port firewalled.

## PCL XL driver

**Why.** Android's Default Print Service does not send the photo: it renders the whole page as a ~108 dpi bitmap
(1261×892 for A4 landscape) with an alpha mask for the transparent margins. Because of the transparency, poppler's
`pdftops` (which cups-filters forces for Dell printers) rasterises the page at the printer resolution: 7008×4958 RGB
at 600 dpi (~104 MB raw, 2.6 MB Flate-compressed PostScript). The Pi needs 25 s for that; the printer's PostScript
interpreter takes 6+ minutes. `-rasterize never` is not an option (the bitmap holds photo pixels under the
transparent margins). Poppler also cannot produce grayscale PostScript, so "black & white" requests were ignored.

**Measured** (same phone page, timed from submit to paper):

| Route | Pi | To printer | Paper | Quality |
|---|---|---|---|---|
| PostScript, pdftops 600 dpi | 25 s | 2.6 MB | 6+ min | — |
| PostScript, pdftops 150 dpi (`pdftops-max-image-resolution`) | 4 s | 2.2 MB | ~35 s | worse, washed-out colours |
| PCL XL 600 dpi, JPEG (`-dCompressMode=2`) | 11 s | 1.8 MB | ~70 s | good |
| PCL XL 600 dpi, DeltaRow (`-dCompressMode=3`, lossless) | 11–14 s | 12 MB | ~60 s | good, same as JPEG |

Text pages: same sharpness as PostScript, ~2 s on the Pi, true grayscale. USB is 2.0 high-speed, so 12 MB is no problem.

**How.** `cups/ppd/Dell-MFP-Laser-3115cn-pxl.ppd` has `*cupsFilter: "application/vnd.cups-pdf 0 dell3115cn-pxl"`, so
every input (PDF, JPEG via `imagetopdf-img2pdf`, PNG, URF/PWG raster, text, PostScript via `gstopdf`) goes through
`pdftopdf` and then `cups/filter/dell3115cn-pxl` (`gs -sDEVICE=pxlcolor|pxlmono -r600 -dCompressMode=3`). Options:
paper size (follows the PDF pages, landscape pages become landscape orientation on portrait media), `InputSlot`
(Auto / Tray 1 = PCL XL `eUpperCassette` / MPF = `eManualFeed`, as the PostScript PPD did), `Duplex`, `ColorModel`.
Text and vectors stay vector; images keep their own resolution.
Dropped with the PostScript PPD: Secure Print, the colour density / balance and other `DL*` PostScript options,
MPF paper type. Every job prints as plain paper.

**Paper types, for whoever has special media.** The printer's own names (PJL `INFO VARIABLES`, `MEDIATYPE`, 43
values): `NORMAL`, `NORMALREV`, `RECYCLED`, `RECYCLE`, `RECYCLEREV`, `FINE`, `HIGHQUALITY`, `HIGHQUALITYREV`,
`THICK`, `THICKSIDE2`, `THICK2`, `THICK2SIDE2`, `SUPERTHICK`, `SUPERTHICKSIDE2`, `COAT`, `COAT1`, `COATEDPAPER`,
`COATEDPAPERREV`, `COAT2`, `COATEDPAPER2`, `COATEDPAPER2REV`, `COAT3`, `COATEDPAPER3`, `COATEDPAPER3REV`, `LABEL`,
`PCMEDIA`, `POSTCARD`, `POSTCARDREV`, `ENVELOPE`, `TRANSPARENCY`, `USERMODE1`–`USERMODE5`, `USER1`–`USER5`,
`ANYMEDIA`, `OFF`, `UNKNOWNMEDIA`. Its panel and web page offer Plain, Plain Thick, Transparency, Covers, Covers Thick,
Label, Coated, Coated Thick and Envelope, plus "S2" variants for the second side. A `MediaType` option in the PPD
could send `@PJL SET MEDIATYPE=…` in the job header (or the PCL XL `MediaType` attribute); which names this model
honours, and how they map to the panel's, is untested: it needs the actual media.

**Ghostscript 10.0 duplex bug.** The PDF interpreter calls `setpagedevice` on every page, and the pxl driver starts a
new sheet whenever it receives `Duplex`, so every page was marked front side (`DuplexPageSide` 0) and a two-sided job
printed one-sided. Ghostscript 10.08 is fixed; the legacy interpreter (`-dNEWPDF=false`) also works but is deprecated.
`cups/filter/pxl-duplex-sides.py` rewrites the side byte (front on odd pages, back on even pages) for two-sided jobs,
independent of the Ghostscript version. Verified on paper.

**Going back** to the PostScript driver: keep a copy of the old PPD before switching (`cp /etc/cups/ppd/<queue>.ppd …`) and restore it with `lpadmin -p <queue> -P <copy>`.

## Tracking dots

Colour-mode prints carry the yellow Xerox/Dell/Epson tracking-dot pattern; grayscale prints don't. Method and findings:
[`SCAN-QUALITY.md`](SCAN-QUALITY.md) ("Yellow tracking dots").

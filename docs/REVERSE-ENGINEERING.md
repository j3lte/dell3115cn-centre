# How this was reverse-engineered

The Dell MFP Laser 3115cn (2006–2008, a Fuji Xerox design) only ever had Windows scanner drivers, and no SANE backend
supports it. Everything in this repository that talks to the scanner, and some of the printer work, comes from reading
Dell's Windows drivers for interoperability and then verifying each finding on the device. This is how, so you can
repeat or extend it. None of Dell's files are included in the repository.

## 1. Get Dell's drivers

All from Dell's support site, product "Dell 3115cn Color Laser Printer" → Drivers & Downloads:

| Package | What's in it | Used for |
|---|---|---|
| `3115_Win8.zip` (scan driver A09) | WIA minidriver `dlsbaisc.dll` (v1.2.1.0), TWAIN source `Dell MFP Laser 3115cn.ds`, the scanner's ICC profile | The USB scan protocol |
| `Printer_3115cn_APP_WIN_A10.zip` | Scan driver, PCL driver (A09) and PostScript driver (A10) | PostScript plugin `dlpsc3fr.dll`, language monitor `dlxbazil.dll`, `DL3115CN.PPD`, the ICC profile |
| `R201964.EXE` (firmware A04, 2012) | Controller and engine images as PJL download jobs, Dell's `dellfwup.exe` | Firmware versions, PJL |

Verify downloads with their published checksums where Dell lists them.

## 2. Unpack

```sh
unzip 3115_Win8.zip -d scan_win8
unzip Printer_3115cn_APP_WIN_A10.zip -d app
# InstallShield payloads (data1.cab + data1.hdr):
unshield -d out x data1.cab
# Files ending in "_" (e.g. DL3115CN.PP_, *.DL_) are Microsoft-compressed:
cabextract -d out FILE.PP_     # or: 7z x FILE.PP_
# The firmware updater is a self-extracting archive:
7z x R201964.EXE -ofirmware     # usually unpacks it; otherwise run it in a Windows VM
```

The scanner's colour profile is `ScanDriver/x64/Dell MFP Laser 3115cn.icm` (see `webapp/assets/README.md` for the
checksum). The PostScript PPD is `DL3115CN.PPD` in the PostScript driver (`cups/README.md`, "Optional").

## 3. Decompile with Ghidra

[Ghidra](https://ghidra-sre.org/) headless mode imports a DLL, runs the auto-analysis and then
[`tools/ghidra/ExportDecomp.java`](../tools/ghidra/ExportDecomp.java), which writes every function's decompiled C to one
file per binary:

```sh
analyzeHeadless /tmp/ghidra dell3115 -import scan_win8/.../dlsbaisc.dll \
  -scriptPath tools/ghidra -postScript ExportDecomp.java decomp/
```

The output is large (tens of thousands of lines per DLL). What helped to find the interesting parts:

- **Strings and imports first.** `DeviceIoControl` and the `usbscan.sys` IOCTL codes (`0x80002028`, `0x8000202c`, …)
  lead straight to the USB transport; WIA property names lead to the scan parameters.
- **Follow the buffers.** The function that builds the 8-byte command block and the 8-byte status block
  (`FUN_0040d956` in `dlsbaisc.dll`) is called from every command; its callers name the commands.
- **Constants with meaning.** `0x0258` (600), `0x27d8` (8.5 inch in 1/1200), paper sizes in mils, `0x32`/`0x36`
  (flatbed/ADF flags) identify the scan window layout.
- **Error paths.** The sense-code handling (`02/3a` feeder empty, `02/53` jam) shows what the device reports and how
  the driver reacts.

## 4. What came out of which binary

| Binary | Finding | Documented in |
|---|---|---|
| `dlsbaisc.dll` (WIA minidriver) | The complete scan protocol: transaction format, command codes, Mode Select pages, Set Window layout (including the second copy of the area that the device requires), image data per mode, ADF behaviour | [`PROTOCOL.md`](PROTOCOL.md) |
| `Dell MFP Laser 3115cn.ds` (TWAIN) | Decompiled as well, but not needed: the WIA minidriver holds the whole protocol | — |
| `dlxbazil.dll` (language monitor) | Toner and other supply levels live in a binary status record that the printer publishes base64-encoded in the `STS:` field of its IEEE 1284 device ID | [`PRINTER.md`](PRINTER.md) "Status record" |
| `dlpsc3fr.dll` / `dlpsc3fu.dll` (PostScript plugin) | Which PostScript/PJL the driver really sends: colour balance, densities, Secure Print (PIN = base64 of the PIN XOR `pfsw`) | [`PRINTER.md`](PRINTER.md) "CUPS PPD analysis" |
| `R201964.EXE` (firmware) | The newest firmware's component versions, to compare with the printer's own report | [`PRINTER.md`](PRINTER.md) "Firmware" |

## 5. Verify on the device

Nothing was trusted until the device confirmed it. The order that worked:

1. **Read-only commands first:** Inquiry, Mode Sense, Test Unit Ready over USB interface 0 with pyusb
   (`tools/scan3115.py probe`). These can't move anything.
2. **One small flatbed scan** at a low resolution, then the full sequence in each mode, comparing image size and line
   layout with the decompiled code.
3. **Feeder last**, with one sheet: jams persist until the ADF cover is opened and closed, and worn rollers double-feed.
4. **Panel button events** by listening on the interrupt endpoint while pressing Scan → Application → JPEG/TIFF/PDF.
5. **Hardware probes** for things the driver never does (1200 dpi, 16-bit): see [`SCAN-QUALITY.md`](SCAN-QUALITY.md).

Printing interface 1 belongs to CUPS (`usblp`); scanning only ever touches interface 0, so both work side by side.

## Printer-side tricks that needed no decompiling

- **PJL** (`@PJL INFO ID`, `INFO CONFIG`, `INFO VARIABLES`, `INFO STATUS`, …) over the printer interface reports
  firmware versions, settings (including the paper-type names) and whether the printer sleeps; supply queries are not
  answered over PJL or PostScript, which is why the device-ID route above was needed.
- **PostScript** `currentsystemparams` and `statusdict` give memory size and the page count (PJL `INFO PAGECOUNT`
  answers 0). The query also wakes a sleeping printer without printing. With "PS Error Report" on, a mistake in such a
  query prints an error page.
- **The printer's own network port as a reference.** SNMP and its web page report supplies, covers, trays and error
  codes in the printer's own words (see [`PRINTER.md`](PRINTER.md) "Network port"). Changing one thing at a time on
  the printer (open a cover, pull a tray, add paper, print a page) and comparing the USB status record with them
  decoded the record's state, error-code and tray bytes, and corrected the supply offsets Dell's driver uses. Do it
  with the print engine awake: in deep power saver it doesn't notice changes.
- The panel's **System Settings** report confirms firmware and options (it contains the serial number and service tag:
  don't publish it).

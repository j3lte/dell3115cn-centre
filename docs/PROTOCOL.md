# Dell 3115cn USB scan protocol

Recovered by decompiling Dell's WIA minidriver `dlsbaisc.dll` v1.2.1.0 (x86, from `3115_Win8.zip`, A09)
with Ghidra 12.1.4. Decompiled sources: `re/decomp/`. Function addresses below refer to that DLL.

Status: **verified on hardware** (Inquiry, Mode Sense, Test Unit Ready, full scan sequence in gray and RGB at 150 dpi).
Reference implementation: `tools/scan3115.py`.

## Transport

- USB interface 0 (vendor class 0xff), unclaimed on Linux.
- Bulk OUT `0x01`, bulk IN `0x82`, both 512-byte packets.
- Interrupt IN `0x85` (8 bytes): button / device events (Windows: `IOCTL_WAIT_ON_DEVICE_EVENT`). Not needed for scanning.
- No vendor control transfers. The Windows driver only uses `usbscan.sys` housekeeping IOCTLs
  (`0x80002028` get pipe config, `0x8000202c` set timeouts, `0x80002004` cancel, `0x80002008` wait for event).

## Transaction (`FUN_0040d956`)

Every command is one transaction:

1. **OUT, 8 bytes, command block**

   | Byte | Meaning |
   |---|---|
   | 0 | Client ID, always `0x00` |
   | 1 | Command code |
   | 2–3 | `0x00 0x00` |
   | 4–7 | Length of the OUT data phase, big-endian u32 (0 if none) |

2. **OUT, data phase** (only for commands that send data): exactly that many bytes.
3. **IN, 8 bytes, status block**

   | Byte | Meaning |
   |---|---|
   | 0 | Client ID, must be `0x00` |
   | 1 | Echo of command code, must match |
   | 2 | Status (see below) |
   | 3 | — |
   | 4–7 | Length of the IN data phase, big-endian u32 |

4. **IN, data phase** (only when status is `0x00` and the command returns data): that many bytes.

**The device sends the status block and data phase in the same bulk transfer** (e.g. Inquiry = one 96-byte transfer).
On Linux an 8-byte read silently drops the rest, so always read whole 512-byte multiples into a buffer and split.

Status byte 3 is not checked by the driver. Observed: `0x0b` idle/setup, `0x0d` while image data remains, `0x0e` on the last Read and after it.

Status byte:

| Value | Meaning | Driver behaviour |
|---|---|---|
| `0x00` | Good | Continue |
| `0x02` | Check condition | Read sense data, length from bytes 4–7 (expected 32). Logged as `[%02X-%02X-%02X]` (key/ASC/ASCQ) |
| `0x08`, `0x09` | Busy / scanning | Sleep 1 s, resend the whole command, up to 40 times |
| `0x18` | Reservation conflict | Fail |
| other `< 0x08` or `0x0a–0x17`, `> 0x18` | — | Treated as success |

## Command codes (`FUN_0040d2d1`)

| Code | Name | OUT data | IN data | Used by WIA driver |
|---|---|---|---|---|
| `0x40` | Reserve Unit | — | — | yes |
| `0x41` | Inquiry | — | 0x58 bytes | yes |
| `0x42` | Test Unit Ready | — | — | yes |
| `0x43` | Mode Sense | — | 0x40 bytes | yes |
| `0x44` | Mode Select | 8 or 0x30 bytes | — | yes |
| `0x45` | Set Window | 0x30 bytes | — | yes |
| `0x46` | Get Window | ? | ? | no |
| `0x47` | Send | ? | ? | no |
| `0x48` | Scan | — | — | yes |
| `0x49` | Read | 4 bytes (BE u32 requested length) | image data | yes |
| `0x4a` | Release Unit | — | — | yes |
| `0x4c` | Scanner Initialize | 4 bytes | — | yes |
| `0x4e` | Read Image Size | ? | ? | no |
| `0x4f` | Wake up | ? | ? | no |

### Inquiry `0x41` (`FUN_0040d888`)

IN data is 0x58 bytes in standard SCSI INQUIRY layout. Observed:
`06 80 02 02 1f 00 00 20` + `DELL Inc.` (vendor, 0x08) + `DELL MFP Laser 3115` (product, 0x10) + `200809111016` (firmware date, ~0x48).
Peripheral type `0x06` = scanner.

### Mode Sense `0x43` (`FUN_0040cf9a`)

IN data 0x40 bytes. Observed:

```
03 06 00 00 00 00 00 00                      page 0x03 (resolution), len 6
20 26 21 ff 00 00 00 00 00 00 27 d8 00 00 36 cf 00 00 27 d8 00 00 41 a0
02 58 02 58 02 58 02 58 00 01 00 01 00 ...   page 0x20, len 0x26
```

Page 0x20 limits are in 1/1200 inch: flatbed 0x27d8 × 0x36cf = 8.5″ × 11.69″ (A4 length),
ADF 0x27d8 × 0x41a0 = 8.5″ × 14″ (Legal). `0x0258` = 600 dpi.
Bit 0 of byte 10 (`0x21`) enables Test Unit Ready calls in the driver.

### Scanner Initialize `0x4c`

4 bytes OUT: `00 00 00 00` at scan start (`FUN_0040ce4d`), `80 00 00 00` at end when cancelling / pages remain (`FUN_0040ce70`).

## Scan sequence (`FUN_0040dc68`, phase `0x100`)

1. `0x40` Reserve Unit (only once; driver tracks reservation).
2. `0x42` Test Unit Ready.
3. `0x4c` Scanner Initialize, data `00 00 00 00`.
4. `0x44` Mode Select, 8 bytes: `03 06 00 00 02 58 00 00`
   (page 3, length 6, base resolution 600 = `0x0258`). An alternative mode writes `03 06 01 00 <xres BE16> 00 00`; the driver defaults to the first.
5. `0x44` Mode Select, 0x30 bytes: `20 2e SS 00 …` (page 0x20, length 0x2e). `SS` = `0x00` flatbed, `0x40` ADF.
6. `0x45` Set Window, 0x30 bytes (all big-endian):

   | Offset | Size | Field |
   |---|---|---|
   | 0x00 | 2 | 0 |
   | 0x02 | 2 | X resolution (dpi) |
   | 0x04 | 2 | Y resolution (dpi) |
   | 0x06 | 2 | 0 |
   | 0x08 | 4 | X offset, 1/600 inch |
   | 0x0c | 4 | Y offset, 1/600 inch |
   | 0x10 | 4 | Width, 1/600 inch, rounded **up to a multiple of 32**; X + width ≤ 5100 (8.5″) |
   | 0x14 | 4 | Height, 1/600 inch, `round(h_px * 600 / yres)` |
   | 0x19 | 1 | Threshold, line art only (`0xc3` default, `0xb4` alternative) |
   | 0x1a | 1 | Composition: `0x00` line art, `0x02` gray, `0x05` RGB |
   | 0x1b | 1 | Bits per channel: 1, 8 or 16 |
   | 0x1d | 1 | Flags: `0x32` flatbed, `0x36` ADF |
   | 0x20 | 16 | **Second copy of X, Y, width, height** (same BE u32 values as 0x08–0x17). Required: without it the device answers check condition, ASC `0x26` (invalid field in parameter list). In the Windows driver this is a scratch variable that happens to live inside the buffer. |

   Supported resolutions (WIA list): 75, 100, 150, 200, 300, 400, 600 dpi.
   Above 600 dpi is refused (probed on hardware, 1″ × 1″ gray): Set Window answers check condition
   `04/26` (invalid field in parameter list) for 600 × 1200, 1200 × 1200, and 1200 × 1200 after the alternative
   Mode Select `03 06 01 00 04 b0 00 00` (which itself is accepted). Mode Sense page 0x20 reports 600 as the maximum.
   If X + width > 5100 the driver shrinks the width, which may leave it not a multiple of 32; the device accepts that.

   Max area: 8500 × 14000 mils (Letter width, Legal length) for ADF; 8490 × 11685 mils (A4 length) for the flatbed (`FUN_0040d4e3`, `FUN_0040d500`).
7. `0x48` Scan.
8. Repeat `0x49` Read: OUT 4 bytes = requested byte count (whole number of raw lines), IN = image data,
   until `height` lines have been read.

### End (phase `0x300`)

`0x4c` Scanner Initialize (`00 00 00 00`, or `80 00 00 00` to abort), then `0x4a` Release Unit.

## Image data

- Raw line length in pixels: `px = ((W600 * xres / 600) + 31) & ~31`, where `W600` is the window width in 1/600 inch.
- Line art (1 bit): `px / 8` bytes per line, **inverted** (driver does `~byte`).
- Gray (8 bit): `px` bytes per line.
- RGB (8 bit/channel): `px * 3` bytes per line, **line-planar**: `R[px] G[px] B[px]` per line.
- RGB 16 bit/channel (probed at 300 dpi): accepted; `px * 6` bytes per line, line-planar, samples
  **little-endian**. Same calibrated tone curve as 8 bit, with highlight headroom (paper white ~53,000 instead of
  clipping at 255); the extra bits mostly carry sensor noise. The service offers it as `"depth": 16`.
- Gray 16 bit: accepted, but the data is not a usable image (it best fits 3-plane lines of `px * 3` samples, with
  garbled content). Use RGB 16 and convert if 16-bit gray is ever needed.
- Lines arrive top to bottom. The driver flips them for BMP and applies an sRGB ICC transform.
- Raw RGB has a magenta cast (white lid: R 238, G 211, B 225). Applying the device profile
  `Dell MFP Laser 3115cn.icm` (from the driver package) then sRGB gives R 252, G 243, B 251.
- Speed: full A4 at 150 dpi RGB takes about 9.5 s (6.7 MB raw); 75 dpi gray about 10 s (flatbed time is mostly mechanical).
- **Lamp warm-up:** the first scan after a long idle took 35 s instead of 10 s (about 25 s warm-up before data arrives). No busy status is reported while warming; the Read simply takes longer.

## ADF (feeder) findings

- **Paper present:** status byte 3 bit `0x40` is set when the feeder holds paper (`0x0b` → `0x4b`). Cheap check with any command, e.g. Test Unit Ready.
- **Feeder empty:** Mode Select page 0x20 with the ADF flag (`20 2e 40 …`) answers check condition, sense key `02`, ASC `0x3a` (medium not present).
  The Windows driver loops pages (max 50) and stops on this: `WIA_ERROR_PAPER_EMPTY` before the first page, `WIA_STATUS_END_OF_MEDIA` after.
- **Jam:** Read answers check condition, sense key `02`, ASC `0x53` (media load/eject failed); status byte 3 `0xee`.
  The jam state persists (Test Unit Ready and Release Unit keep failing with `02/53`, byte 3 `0xa0`) until the feeder cover is opened and closed.
  After that, Initialize + Release + Test Unit Ready recover it.
- During data transfer byte 3 is `0x4d`.
- **Clean page verified** after cleaning the pick rollers: A4, 150 dpi gray, 64 KB Reads, 17.4 s, all 1752 lines;
  the last Read returned exactly the remaining 18 lines with byte 3 `0x4e`.
  Earlier attempts jammed because the rollers could not grip (worn rubber; image showed the page slipping in steps).
- **ADF orientation depends on how the paper is loaded**: one single-page test arrived rotated 180°, a later 3-page batch arrived upright. Never mirrored. Leave rotation to the user or to OCR orientation detection.
- Read size: 64 KB Reads worked; 256 KB Reads failed after the first block while the rollers were slipping (cause unclear, retest).
- **Multi-page loop verified**: per page the full Reserve → … → Read → Initialize → Release sequence; stop when Mode Select (ADF) returns `02/3a`.
  3 pages in 47 s (A4, 150 dpi gray). Status byte 3 drops `0x40` once the last sheet has left the tray.
- **Double feeds are not reported**: with 5 sheets loaded, 3 images came out and every page reported OK. The panel briefly showed a jam.
  Worn separation pad. Possible detection: page count vs. expected, or `0x40` dropping earlier than expected.
- Still to check: window taller than the page (Legal window on A4 paper).

## Button events (interrupt endpoint `0x85`)

Pressing **Scan** on the panel and choosing **Application** plus a file format sends two interrupt transfers:

| Transfer | Bytes | Meaning |
|---|---|---|
| 1 | `00 30 00 00 00 00 00 04` | Scan button, destination "Application" (last byte; other destinations not seen yet) |
| 2 | `01 00 00 0F` | File format chosen on the panel: `01` JPEG, `03` TIFF, `04` PDF (`02` presumably BMP, not seen) |

The device holds these until the host polls the endpoint. After the press the panel shows "Please wait" until the
host starts a scan; starting any scan (Reserve … Read … Release) clears it. The format is only the panel choice;
the host decides the actual scan parameters. The endpoint has `bInterval 11` (polled every 128 ms at high speed):
interrupt reads need a timeout well above that.

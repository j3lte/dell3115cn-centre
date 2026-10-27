# Scan quality: resolution, bit depth, sharpness

Measurements on one Dell 3115cn flatbed. Methods are included so you can repeat them on yours.

## Resolution: 600 dpi is the limit

The scanner reports 600 dpi as its maximum (Mode Sense page `0x20`) and refuses more: Set Window answers check
condition `04/26` (invalid field in parameter list) for 600 × 1200 and 1200 × 1200, also after the alternative Mode
Select form (`03 06 01 00 <xres>`), which itself is accepted. Probe details: [`PROTOCOL.md`](PROTOCOL.md).

## Bit depth: 16-bit colour works, 16-bit gray does not

| Mode | Result |
|---|---|
| Colour, 16 bits per channel | Works: line-planar like 8-bit colour, samples **little-endian**. Same tone curve as 8-bit, with highlight headroom (paper white around 53,000 of 65,535 instead of clipping at 255). The extra bits mostly carry sensor noise. |
| Gray, 16 bits | Accepted, but the data is garbled. Scan in colour and convert. |

The scanner service offers `"depth": 16` for colour; the webapp keeps 16 bits through filters and into PNG/TIFF.

## Sharpness: measured with a razor blade

The standard slanted-edge method (as in ISO 12233): put a straight, sharp edge on the glass a few degrees off the
scan axes, scan it at 600 dpi, and compute the MTF (modulation transfer function, i.e. how much contrast survives at
each level of detail) from the edge profile:

1. find the edge position per line (centroid of the derivative, close to the steepest step only, so a second edge such
   as a blade's bevel doesn't disturb it);
2. fit a line through those positions to get the exact angle;
3. project every pixel near the edge onto the edge normal in 1/4-pixel bins, giving an oversampled edge profile
   (work in linear light, not gamma-encoded values);
4. differentiate to get the line spread function, window it, and Fourier-transform it to get the MTF.

Use a long edge (hundreds of pixels) tilted 2–15°; a short or nearly axis-aligned edge gives a noisy, unreliable curve.
A single-edge razor blade works well: one edge horizontal-ish for the motor direction, then rotated by about 90° for
the sensor direction.

| Detail (line pairs per inch) | Motor direction (Y) | Sensor direction (X) |
|---|---|---|
| 75 | 0.81 | 0.75 |
| 150 | 0.39 | 0.54 |
| 300 (the finest 600 dpi can record) | 0.02 | 0.15 |
| contrast falls to 0.10 at | 243 lp/in | 395 lp/in |

Conclusions:

- **Y:** the optics pass nothing beyond what 600 dpi records, so multi-scan super-resolution cannot add detail.
- **X:** a little detail beyond 600 dpi survives at very low contrast; super-resolution could gain a bit in this direction
  only, at the cost of many scans with the original nudged by hand between them. Not worth it.
- **Real detail is there but washed out** (contrast 0.4–0.5 at 150 lp/in), so undoing the blur pays off: the blur fits
  a Gaussian of σ = 0.70 px across the sensor and 0.87 px along the motor at 600 dpi.

## Sharpening by deconvolution

The webapp's *Sharpen* filter runs Richardson–Lucy deconvolution with that measured Gaussian blur, in linear light.
Colour pages are sharpened through their luminance (the same change is added to R, G and B), which avoids colour fringes
from channels the scanner doesn't register perfectly, and is three times cheaper. The blur scales with dpi and swaps axes
for pages turned 90°. *Light* is 5 iterations, *Normal* 10:

| | Y at 150 lp/in | X at 150 lp/in | Edge overshoot |
|---|---|---|---|
| Original | 0.39 | 0.54 | none |
| Normal (10 iterations) | 0.77 | 0.94 | none |

20 iterations over-sharpens: colour fringes on small black text and noisy paper. It restores contrast up to the optics'
limit; it does not add pixels or invent detail. Implementation: `webapp/src/server/pipeline/deconvolve.ts`.

## White point: a constant cyan cast

Plain office paper on the flatbed, a 40 × 40 mm patch in the middle of the glass, colour, at every resolution:

| | 75 dpi | 150 dpi | 300 dpi | 600 dpi |
|---|---|---|---|---|
| Raw R / G / B (8-bit) | 222 / 239 / 242 | 220 / 237 / 242 | 220 / 237 / 242 | 220 / 237 / 242 |
| After the ICC profile (sRGB) | 245 / 255 / 253 | 244 / 254 / 253 | 244 / 254 / 253 | 244 / 254 / 253 |

- **The same at every resolution.** The paper comes out slightly cyan (red about 4 % low in linear light) at every
  dpi, so one correction per source is enough.
- **Blue is saturated on white:** 242 in 8-bit and 65484 (of 65535) in 16-bit everywhere on the sheet. The scanner
  can't see blue differences in near-white areas, so a correction can only raise red and green, not lower blue.
- **Uneven light:** across a full A4 sheet, raw red and green are 5–8 % lower along the top edge and the right side
  (after the ICC profile, red about 238 at the top against 246 in the middle). Not corrected.
- Office paper often contains optical brighteners and is slightly bluish itself; calibrating on it means "this paper
  is neutral white".

The webapp's *Colour calibration* (Settings) scans a white sheet once per source, through the normal colour pipeline,
and stores per-channel gains that make it neutral (`webapp/src/server/pipeline/white.ts`). Every colour scan from that
source is multiplied by them in linear light right after the ICC profile; gray and black-and-white scans are not
touched. A sheet that is too dark, uneven or needs more than × 1.25 on a channel is refused.

## Yellow tracking dots

Like many colour laser printers, the 3115cn prints the Xerox/Dell/Epson "machine identification code" on
**colour-mode** pages: pale yellow dots (about 0.1 mm) on a 1 mm grid, in blocks that tile the whole page.
Grayscale pages (black toner only) carry no visible pattern.

To find them with the printer's own scanner: scan a mostly white colour print at 600 dpi, normalise to paper white
(the scanner has a slight blue cast), compute yellowness = min(R, G) − B, and look for the 24-pixel (1 mm) period, for
example with an FFT. [DEDA](https://github.com/dfd-tud/deda) (`deda_parse_print`) decodes the pattern but does not detect
the faint dots in a raw scan; it does decode a clean redraw of the detected dot positions. On this printer the decoded
"timestamp" was identical on prints made 25 minutes apart, and the decoded "serial" did not match any number the
printer reports, so what it encodes on this model is unclear. DEDA can also make an anonymisation mask.

The web app's **Analyse → Tracking dots** section does this for you, from a scan on the glass or a colour page in
History: see [`ANALYSE.md`](ANALYSE.md).

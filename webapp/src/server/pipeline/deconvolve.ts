/**
 * Richardson-Lucy deconvolution with the scanner's measured blur (Dell 3115cn flatbed).
 *
 * Slanted-edge measurements at 600 dpi (razor blade): the blur fits a Gaussian of 0.70 px across the sensor (X,
 * image columns) and 0.87 px along the motor (Y, image rows). Contrast at 150 lp/in rises from 0.54/0.39 to about
 * 0.94/0.77 after 10 iterations, without edge overshoot. The scanner refuses more than 600 dpi and passes no detail
 * beyond it vertically, so deconvolution is the useful sharpening; it restores contrast, it does not add pixels.
 */

export const SIGMA_600 = { x: 0.7, y: 0.87 } as const;

export const SHARPEN_ITERATIONS = { off: 0, light: 5, normal: 10 } as const;
export type Sharpen = keyof typeof SHARPEN_ITERATIONS;

/** Below this the blur is under the pixel grid and deconvolution changes nothing visible. */
const MIN_SIGMA = 0.3;
const GAMMA = 2.2;

/** Blur in image pixels for a page scanned at `dpi` and turned by `rotation` degrees (90/270 swap the axes). */
export function psfSigmas(dpi: number, rotation: number): { x: number; y: number } {
  const k = dpi / 600;
  const turned = ((rotation % 360) + 360) % 180 === 90;
  const sx = SIGMA_600.x * k, sy = SIGMA_600.y * k;
  return turned ? { x: sy, y: sx } : { x: sx, y: sy };
}

function gaussian(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  return k;
}

/** Mirror index into [0, n) (reflect without repeating the edge sample, like numpy "reflect"). */
function mirror(i: number, n: number): number {
  if (n === 1) return 0;
  const p = 2 * (n - 1);
  i = ((i % p) + p) % p;
  return i < n ? i : p - i;
}

function edgeTap(src: Float32Array, row: number, x: number, w: number, kx: Float32Array, rx: number): number {
  let s = 0;
  for (let i = 0; i < kx.length; i++) s += kx[i]! * src[row + mirror(x + i - rx, w)]!;
  return s;
}

/** Separable convolution of a w x h plane, mirrored at all four edges. */
function convolve(src: Float32Array, dst: Float32Array, tmp: Float32Array, w: number, h: number, kx: Float32Array, ky: Float32Array): void {
  const rx = (kx.length - 1) / 2, ry = (ky.length - 1) / 2;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < Math.min(rx, w); x++) tmp[row + x] = edgeTap(src, row, x, w, kx, rx);
    for (let x = Math.max(w - rx, rx); x < w; x++) tmp[row + x] = edgeTap(src, row, x, w, kx, rx);
    if (w > 2 * rx) {
      tmp.fill(0, row + rx, row + w - rx);
      for (let i = 0; i < kx.length; i++) {
        const k = kx[i]!, off = row + i - rx; // one tap over the whole interior: a tight, contiguous loop
        for (let x = rx; x < w - rx; x++) tmp[row + x]! += k * src[off + x]!;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    dst.fill(0, row, row + w);
    for (let i = 0; i < ky.length; i++) {
      const k = ky[i]!, src2 = mirror(y + i - ry, h) * w; // whole rows: contiguous memory
      for (let x = 0; x < w; x++) dst[row + x]! += k * tmp[src2 + x]!;
    }
  }
}

const TO_LINEAR = Float32Array.from({ length: 256 }, (_, v) => Math.pow(v / 255, GAMMA));
const LUT_SIZE = 1 << 16;
const TO_8BIT = Uint8Array.from({ length: LUT_SIZE }, (_, i) => Math.round(Math.pow(i / (LUT_SIZE - 1), 1 / GAMMA) * 255));
let toLinear16: Float32Array | null = null;
let to16Bit: Uint16Array | null = null;
/** 16-bit tables, built on first use (256 KB + 128 KB). */
function tables16(): [Float32Array, Uint16Array] {
  toLinear16 ??= Float32Array.from({ length: LUT_SIZE }, (_, v) => Math.pow(v / 65535, GAMMA));
  to16Bit ??= Uint16Array.from({ length: LUT_SIZE }, (_, i) => Math.round(Math.pow(i / (LUT_SIZE - 1), 1 / GAMMA) * 65535));
  return [toLinear16, to16Bit];
}

/**
 * Deconvolves interleaved 8- or 16-bit pixels (1 = gray, 3 = RGB) and returns a new array of the same type. Works in linear light. Colour
 * pages are sharpened through their luminance and the change is added to R, G and B alike: a third of the work, and
 * no colour fringes from channels that the scanner does not register perfectly. Runs one strip of `stripRows` rows at
 * a time; each strip carries enough neighbouring rows that the result matches a single pass over the whole image.
 */
export function deconvolveRaw<T extends Buffer | Uint16Array>(
  data: T,
  w: number,
  h: number,
  channels: 1 | 3,
  iterations: number,
  sigma: { x: number; y: number },
  stripRows = 1024,
): T {
  if (iterations <= 0 || Math.max(sigma.x, sigma.y) < MIN_SIGMA) return data;
  const wide = data instanceof Uint16Array;
  const [lin, enc]: [Float32Array, Uint8Array | Uint16Array] = wide ? tables16() : [TO_LINEAR, TO_8BIT];
  const kx = gaussian(sigma.x), ky = gaussian(sigma.y);
  const ry = (ky.length - 1) / 2;
  const margin = Math.min(h, 2 * ry * iterations + ry); // rows that influence the strip after all iterations
  const out = (wide ? new Uint16Array(data.length) : Buffer.alloc(data.length)) as T;
  const cap = (stripRows + 2 * margin) * w;
  const obs = new Float32Array(cap), est = new Float32Array(cap), blur = new Float32Array(cap), tmp = new Float32Array(cap);

  for (let y0 = 0; y0 < h; y0 += stripRows) {
    const y1 = Math.min(h, y0 + stripRows);
    const a = Math.max(0, y0 - margin), b = Math.min(h, y1 + margin), sh = b - a, n = sh * w;
    for (let i = 0, p = a * w * channels; i < n; i++, p += channels)
      obs[i] = est[i] =
        channels === 1 ? lin[data[p]!]! : 0.2126 * lin[data[p]!]! + 0.7152 * lin[data[p + 1]!]! + 0.0722 * lin[data[p + 2]!]!;
    const o = obs.subarray(0, n), e = est.subarray(0, n), bl = blur.subarray(0, n), t = tmp.subarray(0, n);
    for (let it = 0; it < iterations; it++) {
      convolve(e, bl, t, w, sh, kx, ky);
      for (let i = 0; i < n; i++) bl[i] = o[i]! / Math.max(bl[i]!, 1e-6);
      convolve(bl, bl, t, w, sh, kx, ky); // symmetric kernel: correlation = convolution
      for (let i = 0; i < n; i++) e[i]! *= bl[i]!;
    }
    for (let i = (y0 - a) * w, end = (y1 - a) * w, p = y0 * w * channels; i < end; i++) {
      const delta = e[i]! - o[i]!;
      for (let c = 0; c < channels; c++, p++) {
        const v = lin[data[p]!]! + delta;
        out[p] = enc[v <= 0 ? 0 : v >= 1 ? LUT_SIZE - 1 : Math.round(v * (LUT_SIZE - 1))]!;
      }
    }
  }
  return out;
}

/**
 * ImageMagick binary: `magick` (IM7, e.g. Homebrew) when present, else `convert` (IM6).
 * Both accept the same convert-style arguments. The Docker image (Alpine) has IM7.
 */
export function magickCommand(): string[] {
  if (Bun.which("magick")) return ["magick"];
  return ["convert"];
}

export function magickAvailable(): boolean {
  return !!(Bun.which("magick") || Bun.which("convert"));
}

/** Runs ImageMagick with convert-style args; stdin optional. Throws with stderr on failure. */
export async function runMagick(args: string[], stdin?: Uint8Array): Promise<Uint8Array> {
  const proc = Bun.spawn([...magickCommand(), ...args], {
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`ImageMagick failed (${code}): ${err.trim().split("\n").slice(-3).join(" ")}`);
  return new Uint8Array(out);
}

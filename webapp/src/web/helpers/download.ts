/** Starts browser downloads for the given URLs (the files of a Download delivery). */
export function downloadFiles(files: { name: string; url: string }[]): void {
  files.forEach((f, i) => {
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = f.url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 400);
  });
}

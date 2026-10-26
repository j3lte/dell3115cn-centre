"""Tests for the dell3115cn-pxl CUPS filter (PDF -> PCL XL via Ghostscript).

Run: uv run --with pytest pytest cups/tests
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

CUPS = Path(__file__).resolve().parent.parent
FILTER = CUPS / "filter" / "dell3115cn-pxl"
PPD = CUPS / "ppd" / "Dell-MFP-Laser-3115cn-pxl.ppd"

# PCL XL "ubyte attribute": 0xc0 <value> 0xf8 <attribute id>
ORIENTATION, MEDIA_SOURCE, SIMPLEX, DUPLEX_MODE, DUPLEX_SIDE = 0x28, 0x26, 0x34, 0x35, 0x36


def uba(value: int, attr: int) -> bytes:
    return bytes([0xC0, value, 0xF8, attr])


def make_pdf(path: Path, width: int, height: int, pages: int = 1) -> Path:
    """Minimal PDF with `pages` pages of width x height points, each with a filled rectangle."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>"]
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(pages))
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>")
    content = b"1 0 0 rg 72 72 144 144 re f"
    for i in range(pages):
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Contents {4 + 2 * i} 0 R >>"
        )
        objs.append(f"<< /Length {len(content)} >>\nstream\n{content.decode()}\nendstream")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for n, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n{body}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(bytes(out))
    return path


def run_filter(options: str, *, pdf: Path | None = None, stdin: bytes | None = None, gs: str | None = None):
    env = {k: v for k, v in os.environ.items() if k != "PPD"}
    env["PPD"] = str(PPD)
    env["DELL3115_PXL_SIDES"] = str(CUPS / "filter" / "pxl-duplex-sides.py")
    if gs is not None:
        env["DELL3115_GS"] = gs
    args = [str(FILTER), "1", "user", "title", "1", options]
    if pdf is not None:
        args.append(str(pdf))
    return subprocess.run(args, input=stdin, capture_output=True, env=env, timeout=120)


def write_stub(path: Path, body: str) -> str:
    """Fake gs: `body` runs with $OUT set from -sOutputFile (%stdout -> /dev/stdout)."""
    path.write_text(
        "#!/bin/sh\n"
        'for a in "$@"; do case "$a" in -sOutputFile=*) OUT=${a#*=} ;; esac; done\n'
        '[ "$OUT" = %stdout ] && OUT=/dev/stdout\n' + body + "\n"
    )
    path.chmod(0o755)
    return str(path)


@pytest.fixture
def stub_gs(tmp_path):
    """A fake gs that records its arguments, one per line, and writes a marker to stdout."""
    log = tmp_path / "gs-args"
    stub = write_stub(tmp_path / "gs", f'printf "%s\\n" "$@" > "{log}"\nprintf PXL > "$OUT"')

    def args(options: str, **kw) -> list[str]:
        res = run_filter(options, gs=stub, **kw)
        assert res.returncode == 0, res.stderr.decode()
        assert res.stdout == b"PXL"
        return log.read_text().splitlines()

    return args


@pytest.fixture
def pdf(tmp_path):
    return make_pdf(tmp_path / "in.pdf", 595, 842)


def test_defaults_from_ppd_colour_simplex_auto_tray(stub_gs, pdf):
    a = stub_gs("", pdf=pdf)
    assert "-sDEVICE=pxlcolor" in a
    assert "-r600" in a
    assert "-dCompressMode=3" in a
    assert not any(x.startswith(("-dDuplex", "-dManualFeed", "-dMediaPosition")) for x in a)
    assert a[-1] == str(pdf)


def test_grayscale_uses_pxlmono(stub_gs, pdf):
    assert "-sDEVICE=pxlmono" in stub_gs("ColorModel=Gray", pdf=pdf)


def test_ipp_monochrome_without_ppd_option(stub_gs, pdf):
    assert "-sDEVICE=pxlmono" in stub_gs("print-color-mode=monochrome", pdf=pdf)


def test_ppd_option_wins_over_ipp_attribute(stub_gs, pdf):
    assert "-sDEVICE=pxlcolor" in stub_gs("print-color-mode=monochrome ColorModel=RGB", pdf=pdf)


@pytest.mark.parametrize(
    "options, expected",
    [
        ("Duplex=DuplexNoTumble", ["-dDuplex=true", "-dTumble=false"]),
        ("Duplex=DuplexTumble", ["-dDuplex=true", "-dTumble=true"]),
        ("sides=two-sided-long-edge", ["-dDuplex=true", "-dTumble=false"]),
        ("sides=two-sided-short-edge", ["-dDuplex=true", "-dTumble=true"]),
    ],
)
def test_duplex(stub_gs, pdf, options, expected):
    a = stub_gs(options, pdf=pdf)
    for e in expected:
        assert e in a


def test_simplex_option_sends_no_duplex(stub_gs, pdf):
    a = stub_gs("Duplex=None sides=two-sided-long-edge", pdf=pdf)
    assert not any(x.startswith("-dDuplex") for x in a)


@pytest.mark.parametrize(
    "options, expected",
    [("InputSlot=BypassTray", "-dManualFeed=true"), ("InputSlot=1stTray", "-dMediaPosition=4")],
)
def test_input_slot(stub_gs, pdf, options, expected):
    assert expected in stub_gs(options, pdf=pdf)


def test_reads_pdf_from_stdin(stub_gs, pdf):
    a = stub_gs("", stdin=pdf.read_bytes())
    src = Path(a[-1])
    assert src.name.endswith(".pdf")


FOUR_FRONT_PAGES = (bytes.fromhex("c001f835 c000f836 43") + b"\x00" * 20) * 4


@pytest.fixture
def stub_gs_pages(tmp_path):
    """A fake gs that writes four duplex page headers, all marked front side (Ghostscript 10.0 bug)."""
    data = tmp_path / "pages.bin"
    data.write_bytes(FOUR_FRONT_PAGES)
    return write_stub(tmp_path / "gs", f'cat "{data}" > "$OUT"')


def page_sides(out: bytes) -> list[int]:
    return [out[i + 5] for i in range(len(out) - 8) if out[i : i + 4] == bytes.fromhex("c001f835")]


def test_duplex_job_gets_alternating_sides(stub_gs_pages, pdf):
    res = run_filter("Duplex=DuplexNoTumble", pdf=pdf, gs=stub_gs_pages)
    assert res.returncode == 0, res.stderr.decode()
    assert page_sides(res.stdout) == [0, 1, 0, 1]


def test_simplex_job_output_untouched(stub_gs_pages, pdf):
    res = run_filter("Duplex=None", pdf=pdf, gs=stub_gs_pages)
    assert res.returncode == 0, res.stderr.decode()
    assert res.stdout == FOUR_FRONT_PAGES


def test_gs_failure_fails_the_duplex_job(tmp_path, pdf):
    bad = write_stub(tmp_path / "gs", 'printf partial > "$OUT"\nexit 1')
    res = run_filter("Duplex=DuplexTumble", pdf=pdf, gs=bad)
    assert res.returncode != 0
    assert res.stdout == b""


def test_gs_failure_fails_the_job(tmp_path, pdf):
    bad = tmp_path / "gs"
    bad.write_text("#!/bin/sh\necho boom >&2\nexit 1\n")
    bad.chmod(0o755)
    res = run_filter("", pdf=pdf, gs=str(bad))
    assert res.returncode != 0
    assert b"boom" in res.stderr


# --- real Ghostscript -------------------------------------------------------------------------

GS = shutil.which("gs")
real_gs = pytest.mark.skipif(GS is None, reason="Ghostscript not installed")


@real_gs
def test_real_gs_colour_page(pdf):
    res = run_filter("", pdf=pdf, gs=GS)
    assert res.returncode == 0, res.stderr.decode()
    out = res.stdout
    assert out.startswith(b"\x1b%-12345X@PJL")
    assert b"@PJL SET RENDERMODE=COLOR" in out
    assert b"ENTER LANGUAGE = PCLXL" in out
    assert uba(0, ORIENTATION) in out  # portrait
    assert uba(1, MEDIA_SOURCE) in out  # eAutoSelect


@real_gs
def test_real_gs_grayscale(pdf):
    res = run_filter("ColorModel=Gray", pdf=pdf, gs=GS)
    assert res.returncode == 0, res.stderr.decode()
    assert b"@PJL SET RENDERMODE=GRAYSCALE" in res.stdout


@real_gs
def test_real_gs_landscape_page_on_portrait_paper(tmp_path):
    land = make_pdf(tmp_path / "land.pdf", 842, 595)
    res = run_filter("", pdf=land, gs=GS)
    assert res.returncode == 0, res.stderr.decode()
    assert uba(1, ORIENTATION) in res.stdout  # eLandscapeOrientation, A4 media


@real_gs
def test_real_gs_duplex_long_edge_and_bypass(tmp_path):
    two = make_pdf(tmp_path / "two.pdf", 595, 842, pages=2)
    res = run_filter("Duplex=DuplexNoTumble InputSlot=BypassTray", pdf=two, gs=GS)
    assert res.returncode == 0, res.stderr.decode()
    assert uba(1, DUPLEX_MODE) in res.stdout  # eDuplexVerticalBinding (1) = long edge
    assert uba(1, DUPLEX_SIDE) in res.stdout  # page 2 on the back
    assert uba(2, MEDIA_SOURCE) in res.stdout  # eManualFeed
    assert uba(0, SIMPLEX) not in res.stdout

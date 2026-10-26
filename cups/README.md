# CUPS printing for the Dell MFP Laser 3115cn

Printing over USB from a Linux print server (tested on a Raspberry Pi Zero 2 W, Debian 12, CUPS 2.4, Ghostscript 10).
The default driver renders **PCL XL on the server with Ghostscript**: much faster and better colour than the printer's
own PostScript interpreter. Why, with measurements: [`../docs/PRINTER.md`](../docs/PRINTER.md) ("Printing speed",
"PCL XL driver").

| File | What |
|---|---|
| `ppd/Dell-MFP-Laser-3115cn-pxl.ppd` | The PPD: paper size, tray (auto / tray 1 / MPF), two-sided, colour or grayscale. |
| `filter/dell3115cn-pxl` | CUPS filter PDF → PCL XL (`gs -sDEVICE=pxlcolor`/`pxlmono`, 600 dpi, lossless DeltaRow). |
| `filter/pxl-duplex-sides.py` | Fixes Ghostscript 10.0 marking every two-sided page as a front side. |
| `filter/imagetopdf-img2pdf` + `filter/local.convs` | Keeps JPEGs compressed (`img2pdf`) instead of cups-filters' `imagetopdf`. |
| `backend/dell3115cn` + `backend/dell3115cn-supplies.py` | Backend wrapper that reports toner, belt unit and fuser levels, alerts (covers, trays, error codes) and the page count (read over USB) to CUPS. |
| `systemd/dell3115cn-supplies.{service,timer}` | Refreshes those levels at boot and every 6 h without printing. |
| `ppd/fix-ppd.py` | Optional: fixes Dell's own PostScript PPD if you prefer that driver (see below). |
| `tests/` | Filter tests: `uv run --with pytest pytest cups/tests` (Ghostscript needed for the end-to-end ones). |

## Install

```sh
sudo apt-get install -y cups ghostscript img2pdf python3
cd cups

# filters
sudo install -m 755 filter/dell3115cn-pxl filter/imagetopdf-img2pdf /usr/lib/cups/filter/
sudo install -m 644 filter/local.convs /etc/cups/local.convs
sudo install -d /usr/local/lib/dell3115cn
sudo install -m 755 filter/pxl-duplex-sides.py backend/dell3115cn-supplies.py /usr/local/lib/dell3115cn/

# backend wrapper (0700 root: CUPS then runs it, and the usb backend, as root)
sudo install -o root -g root -m 700 backend/dell3115cn /usr/lib/cups/backend/

# queue: find the printer's USB URI, then create the queue with the wrapper in front of it
lpinfo -v | grep -i 3115                     # e.g. direct usb://Dell/MFP%20Laser%203115cn?serial=…&interface=1
sudo lpadmin -p Dell_MFP_Laser_3115cn -E -v "dell3115cn:<usb URI from above>" -P ppd/Dell-MFP-Laser-3115cn-pxl.ppd \
  -o printer-is-shared=true
sudo cupsctl --share-printers

# supply levels at boot and every 6 h
sudo install -m 644 systemd/dell3115cn-supplies.* /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now dell3115cn-supplies.timer
```

Check that every input type ends in the PCL XL filter:

```sh
sudo cupsfilter -e --list-filters -p /etc/cups/ppd/Dell_MFP_Laser_3115cn.ppd -m printer/foo -i application/pdf /dev/null
```

Other queue name: `QUEUE=<name>` in `/etc/default/dell3115cn-supplies`. If the toner order on your printer differs
from cyan, magenta, yellow, black: `DELL3115_TONER_ORDER` in the same file.

Never restart `cupsd` while a job is printing (`lpstat -o` must be empty): the job restarts and can arrive at the
printer twice.

## Clients

The shared queue is announced over mDNS as AirPrint / IPP Everywhere / Mopria, so iOS, macOS (add it as an IPP
printer) and Android's Default Print Service find it without drivers. Details: [`../docs/PRINTER.md`](../docs/PRINTER.md)
("Network printing setup").

## Optional: Dell's PostScript driver

Dell's PostScript PPD (`DL3115CN.PPD`, in Dell's Windows PostScript driver package) is not included: it is Dell's
copyright. If you want it anyway, extract it as described in
[`../docs/REVERSE-ENGINEERING.md`](../docs/REVERSE-ENGINEERING.md) and fix it with `ppd/fix-ppd.py IN.ppd OUT.ppd`
(it removes a colour-balance call that fails on every job and stops CUPS overriding the panel's density settings).
It prints much more slowly than the PCL XL driver, and poppler cannot make grayscale PostScript.

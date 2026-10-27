# Input and output profiles

A scan uses two profiles: an **input profile** (how to scan) and an **output profile** (what file to make and where
to send it). Manage them on the *Profiles* page. A new installation starts with the common profiles below;
*Add common profiles* adds back any of them whose name is missing, and leaves profiles you edited alone.

## Input profiles

### Common input profiles

| Name | Source | Mode | dpi | Paper | Auto-orient | Filter |
|---|---|---|---|---|---|---|
| Document (feeder, gray 300) | feeder | gray | 300 | A4 | yes | document |
| Document (flatbed, gray 300) | flatbed | gray | 300 | glass | yes | document |
| Colour document (feeder, colour 200) | feeder | colour | 200 | A4 | yes | document |
| Text black & white (feeder, 300) | feeder | line art | 300 | A4 | yes | none |
| Receipt (flatbed, gray 300) | flatbed | gray | 300 | glass | yes | document + auto-crop + straighten |
| Photo (flatbed, colour 300) | flatbed | colour | 300 | glass | no | none |
| Photo high quality (flatbed, colour 600) | flatbed | colour | 600 | glass | no | none |

### Settings

| Setting | Values | Notes |
|---|---|---|
| Source | flatbed, feeder | |
| Mode | line art, gray, colour | Line art is 1 bit per pixel, made by the scanner. |
| Resolution | 75, 100, 150, 200, 300, 400, 600 dpi | 600 dpi is the scanner's limit ([`SCAN-QUALITY.md`](../../docs/SCAN-QUALITY.md)). |
| Paper | flatbed: glass; feeder: A4, Letter, Legal | On the flatbed, *Preview* lets you scan a region. |
| Threshold | 0–255 (default 128) | Line art only: the scanner's black/white cut-off. |
| 16 bits per colour | on, off (default off) | Colour only: the scanner's 16-bit gray is unusable. Kept in PNG and TIFF; PDF and JPEG are 8-bit. Files are twice as large. |
| Auto-orient | on, off | Turns pages upright with Tesseract's orientation detection. Pages with too little text stay as scanned. |
| Filter | see below | The default filter for one-tap scans and the review tray's starting point. |


### Filters

A filter runs in this order: sharpen, straighten, auto-crop, preset, brightness/contrast. In the review tray you can
change the filter for the whole scan or for one page.

| Setting | Values | What it does |
|---|---|---|
| Preset | none, document, grayscale, black & white | *Document* stretches the levels, lifts the paper to white and sharpens lightly; it also evens out the scanner's slight colour tint on white. *Grayscale* converts to gray. *Black & white* converts to 1 bit with its own threshold. |
| Threshold | 0–255 (default 160) | Black & white preset only. |
| Brightness | −100 to 100 | Applied before the threshold for black & white, so it still has an effect. |
| Contrast | −100 to 100 | As brightness. |
| Auto-crop | on, off | Trims the empty border around the document (useful on the flatbed). |
| Straighten | on, off | Deskews pages that went in at a slight angle. |
| Sharpen | off, light, normal | Undoes the scanner's measured blur (5 or 10 deconvolution iterations, [`SCAN-QUALITY.md`](../../docs/SCAN-QUALITY.md)). Applied to the delivered files, not to previews. |

## Output profiles

### Common output profiles

All common output profiles download the file to the browser, with JPEG quality 85.

| Name | Format | File name template |
|---|---|---|
| Download PDF | PDF, all pages in one file | `{date}_{time}_scan` |
| Download PDF per page | PDF, one file per page | `{date}_{time}_scan_{page}` |
| Download JPEG | JPEG, one file per page | `{date}_{time}_scan_{page}` |
| Download PNG | PNG, one file per page | `{date}_{time}_scan_{page}` |
| Download TIFF | TIFF, all pages in one file | `{date}_{time}_scan` |

### Formats

| Format | Pages | Encoding |
|---|---|---|
| PDF (multi-page) | one file | Line art: 1-bit, lossless. Gray and colour: JPEG at the profile's quality. The page is the size of the scanned area. |
| PDF (one per page) | one file per page | As above. |
| PNG | one file per page | Lossless; 16-bit scans stay 16-bit. |
| JPEG | one file per page | At the profile's quality (1–100); gray stays single-channel. |
| TIFF (multi-page) | one file | Line art: CCITT G4. Gray and colour: LZW; 16-bit scans stay 16-bit. |
| TIFF (one per page) | one file per page | As above. |

All formats carry the scan resolution, so pages print at their real size.

### File name template

| Placeholder | Becomes |
|---|---|
| `{date}` | date, `YYYY-MM-DD` |
| `{time}` | time, `HHmm` |
| `{datetime}` | `YYYY-MM-DD_HHmmss` |
| `{profile}` | output profile name, as a slug (`Archive → Paperless` becomes `archive-paperless`) |
| `{input}` | input profile name, as a slug |
| `{n}` | running scan number, 4 digits |
| `{page}` | page number, 3 digits; empty for single-file formats |

Dates and times use the container's time zone (`TZ`). Unknown placeholders stay as written. Characters that file
systems or shares don't accept are removed. PDF and TIFF one-per-page add `_001`, `_002`, … when the template has no
`{page}`; other duplicate names within one scan get `-2`, `-3`, …. Folder, SFTP and FTP destinations never overwrite:
a name that already exists there also gets `-2`, `-3`, ….

### Destinations

Each destination has a **Test** button that checks the settings without sending a scan. Passwords, tokens and keys are
encrypted with `APP_SECRET` and never shown again in full.

| Destination | Settings | Notes |
|---|---|---|
| Download | none | The browser downloads the file. Files stay available in History. |
| Folder | path | A path inside the container. Mount the target as a volume; the folder must already exist and is never created, so a missing mount can't swallow scans. |
| SFTP (SSH) | host, port (22), folder (empty: the login folder), user name, password and/or private key, passphrase | Uploads to a folder on any machine with an SSH server (Linux, macOS, most NAS). See [SFTP](#sftp) below. |
| FTP | host, port (21), path (`/`), user name (`anonymous`), password, FTPS on/off | |
| Paperless-ngx | URL, API token, tags (ids), correspondent (id) | Uploads to Paperless's document API. The title is the file name. |
| Papra | URL, API key, organisation id | |
| Webhook | URL, optional header name and value | `POST` as `multipart/form-data`: one `file` field per file, plus a `meta` field with JSON `{ scanId, title, files }`. The test sends `meta` `{ "test": true }` and no files. |

#### SFTP

- **Login**: a password, or a private key (paste the whole key file, `-----BEGIN OPENSSH PRIVATE KEY-----` …
  `-----END …-----`; the matching public key goes in `~/.ssh/authorized_keys` on the server) with its passphrase if
  it has one. A key that can't be read, or that needs a passphrase that's missing or wrong, is refused when saving.
- **Folder**: relative to the login folder, or absolute (`/srv/scans`). It must already exist. **Test** checks that
  it exists and that the user can write there, by creating and removing an empty `.centre-test-…` file.
- **Host key (trust on first use)**: the first successful Test, or the first delivery if the profile was never
  tested, stores the server's host key fingerprint (`SHA256:…`, as `ssh-keygen -lf` shows it) in the profile; the
  form shows it under *Host key*. From then on a server that shows another key is refused before logging in, with
  *Host key of … changed (expected …, got …)*. If the key really changed (server reinstalled, new host keys), press
  *Forget host key* and save; the next Test trusts the new key. Saving the profile otherwise never clears the stored
  key (not even from a form opened before the key was stored); changing the host or port does. Check the fingerprint
  against the server (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) if you want to be sure.
- Files that already exist are never overwritten (see the numbering above).

SMB shares are no longer supported (the image no longer contains `smbclient`). An output profile that still uses SMB
shows *SMB share (no longer supported)*; its deliveries and tests fail until you switch it to another destination,
for example SFTP to the same NAS or a Folder destination on a mounted share.

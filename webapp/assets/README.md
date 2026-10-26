# Scanner colour profile

Colour scans need the scanner's own ICC profile to come out neutral; without it they have a magenta cast. The profile
is Dell's (`Copyright (c) 2006 Dell Inc.`) and is not included in this repository.

It ships in Dell's Windows scan driver for the 3115cn, available from Dell's support site for the "Dell 3115cn Color
Laser Printer" (Drivers & Downloads, the Windows scanner driver / application package, e.g.
`Printer_3115cn_APP_WIN_A10.zip`). Inside it:

```
Printer_3115cn_Scan_Driver_Dell_A09_WIN/ScanDriver/x64/Dell MFP Laser 3115cn.icm
```

33,304 bytes, SHA-256 `b2259533e4e3951d4b8ae49cec337d23b1f5a88c7a5bb37fc9d6a277a36ee9ec` (the x86 and Vista copies
are identical). The older `3115_Win8.zip` scan driver has the same file under `ScanDriver/`.

```sh
unzip -j Printer_3115cn_APP_WIN_A10.zip "Printer_3115cn_Scan_Driver_Dell_A09_WIN/ScanDriver/x64/Dell MFP Laser 3115cn.icm"
mv "Dell MFP Laser 3115cn.icm" webapp/assets/dell3115cn.icm
shasum -a 256 webapp/assets/dell3115cn.icm
```

Then either build the image with the file in `assets/`, mount it at `/app/assets/dell3115cn.icm` (see `compose.yml`),
or point `DEVICE_ICC` at it.

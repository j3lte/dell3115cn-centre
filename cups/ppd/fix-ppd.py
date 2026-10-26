#!/usr/bin/env python3
"""Fix the community Dell 3115cn PPD (see docs/PRINTER.md, "CUPS PPD analysis").

1. DLColorBalanceAdjustment sent `true|false/Custom/ProcSet findresource/setcolorbalance get exec`,
   a call Dell's driver never makes (setcolorbalance takes /Colour /Band n). It becomes UI-only.
2. The 12 DLColorDensity* options were sent on every job (value 0), possibly overriding density
   adjustments made on the printer panel. Dell's driver only sends them when colour balance is
   adjusted. Each option gets a new default choice "Printer setting" that sends nothing.

Usage: fix-ppd.py IN.ppd OUT.ppd   (idempotent; keeps the input's line endings)
"""
import re
import sys

NOTE = ("*% 2026-10-26 fix: DLColorBalanceAdjustment is UI-only (no bogus setcolorbalance call);\n"
        "*%   DLColorDensity* default to \"Printer setting\" (send nothing) like Dell's own driver.\n")


def fix(text: str) -> str:
    nl = "\r\n" if "\r\n" in text else "\n"
    t = text.replace("\r\n", "\n")
    if "2026-10-26 fix:" in t:
        return text
    t = re.sub(r'(\*DLColorBalanceAdjustment (?:False|True)/[^:]+: )"[^"]*"', r'\1""', t)

    def density(m: re.Match) -> str:
        block, name = m.group(0), m.group(1)
        block = re.sub(rf"\*Default{name}: \S+", f"*Default{name}: Printer", block)
        return block.replace(f"*CloseUI: *{name}",
                             f'*{name} Printer/Printer setting: ""\n*CloseUI: *{name}')

    t = re.sub(r"\*OpenUI \*(DLColorDensity\w+)/.*?\*CloseUI: \*\1\n", density, t, flags=re.S)
    t = t.replace("*% === Options and Constraints", NOTE + "*% === Options and Constraints", 1)
    return t.replace("\n", nl)


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf-8", newline="") as f:
        out = fix(f.read())
    with open(dst, "w", encoding="utf-8", newline="") as f:
        f.write(out)

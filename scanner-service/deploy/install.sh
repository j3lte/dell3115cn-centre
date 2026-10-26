#!/bin/sh
# Install or update the scanner service. Run on the machine the printer is plugged into:
#   sudo ./deploy/install.sh
# Idempotent: safe to re-run after pulling a new version.
set -eu

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
here=$(cd "$(dirname "$0")/.." && pwd)

apt-get install -y -qq python3 python3-usb >/dev/null

getent group scanner >/dev/null || groupadd --system scanner
id scan3115 >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin --gid scanner scan3115

install -d -m 0755 /opt/scan3115
rm -rf /opt/scan3115/scan3115
cp -r "$here/scan3115" /opt/scan3115/
find /opt/scan3115 -name __pycache__ -prune -exec rm -rf {} +

install -m 0644 "$here/deploy/60-scan3115.rules" /etc/udev/rules.d/60-scan3115.rules
udevadm control --reload
udevadm trigger --subsystem-match=usb --attr-match=idVendor=413c

install -m 0644 "$here/deploy/scan3115.service" /etc/systemd/system/scan3115.service
systemctl daemon-reload
systemctl enable scan3115 >/dev/null
systemctl restart scan3115
sleep 2
systemctl --no-pager --lines=5 status scan3115 | sed -n '1,8p'

#!/bin/sh
# Installs Google Chrome stable at a pinned build, for both images (Dockerfile, Dockerfile.video).
# guarded-browser.mjs launches it with Playwright's channel 'chrome' (ops I-1114): Playwright 1.64.1's own
# Chromium, 156.0.8078.4, lacks the fixes Chrome 156.0.8078.73 shipped for four Critical CVEs, one of them a
# sandbox escape, and no stable Playwright bundles a newer one yet.
#
# To update: take google-chrome-stable's Version and SHA256 from
# https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages. Google's pool keeps older
# builds for a while (155.0.8059.84 was still there on 2026-11-03), so a pinned build stays downloadable after
# the next release. Keep the major version one that this Playwright supports (its release notes list the
# Chrome stable it was tested against).
set -eu

CHROME_VERSION=156.0.8078.79-1
CHROME_SHA256=be1a1e161419f5c8272432f6860912550d8e29985e925913fa800493a0d0c955

deb=/tmp/google-chrome-stable.deb
apt-get update
apt-get install -y --no-install-recommends ca-certificates wget
wget -q -O "$deb" "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb"
echo "$CHROME_SHA256  $deb" | sha256sum -c -
apt-get install -y --no-install-recommends "$deb"
rm -f "$deb"
rm -rf /var/lib/apt/lists/*
/opt/google/chrome/chrome --version

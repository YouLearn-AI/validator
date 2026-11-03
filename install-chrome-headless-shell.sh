#!/bin/sh
# Installs Chrome for Testing's headless shell at a pinned build, for both images (Dockerfile, Dockerfile.video).
# It is the browser Playwright itself downloads for headless Chromium, at a newer Chrome build (ops I-1114):
# Playwright 1.64.1's own, 156.0.8078.4, lacks the fixes Chrome 156.0.8078.73 shipped for four Critical CVEs,
# one of them a sandbox escape, and no stable Playwright bundles a newer one yet. The Dockerfiles point
# guarded-browser.mjs at it (CHROMIUM_EXECUTABLE_PATH).
#
# To update: take a version from
# https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json (the Stable
# channel's, on the major this Playwright supports), download its linux64 chrome-headless-shell zip and set the
# SHA-256 here. Check the download against the bucket's own MD5 first (`curl -I` gives x-goog-hash md5=...).
set -eu

VERSION=156.0.8078.80
SHA256=547dcd374e02961bf998f6046a267644f8502225c36bb78ca307dab32a0b3eb4

zip=/tmp/chrome-headless-shell-linux64.zip
apt-get update
apt-get install -y --no-install-recommends ca-certificates wget unzip
wget -q -O "$zip" "https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/linux64/chrome-headless-shell-linux64.zip"
echo "$SHA256  $zip" | sha256sum -c -
unzip -q "$zip" -d /opt
rm -f "$zip"
apt-get purge -y --auto-remove unzip
rm -rf /var/lib/apt/lists/*
/opt/chrome-headless-shell-linux64/chrome-headless-shell --version

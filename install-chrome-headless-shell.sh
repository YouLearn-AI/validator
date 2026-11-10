#!/bin/sh
# Installs Chrome for Testing's headless shell at a pinned build, for both images (Dockerfile, Dockerfile.video).
# It is the browser Playwright itself downloads for headless Chromium, at Chrome's current Stable build instead
# of the one Playwright bundles (ops I-1114): Playwright 1.64.1's own, 156.0.8078.4, lacks the fixes Chrome
# 156.0.8078.73 shipped for four Critical CVEs, one of them a sandbox escape. Chrome 157.0.8103.38 adds 213
# security fixes, 7 of them Critical, and 157.0.8103.50 fixes CVE-2026-125350, a use after free in XML that
# Google says is exploited in the wild (ops I-1343). The Dockerfiles point guarded-browser.mjs at it
# (CHROMIUM_EXECUTABLE_PATH).
#
# To update: take the Stable channel's version from
# https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json, download its
# linux64 chrome-headless-shell zip and set the SHA-256 here. Check the download against the bucket's own MD5
# first (`curl -I` gives x-goog-hash md5=...). When that Stable is a newer major than the Chromium this Playwright
# bundles (node_modules/playwright-core/browsers.json), run the test suite against the same version first, with
# CHROMIUM_EXECUTABLE_PATH set to Chrome for Testing's headless shell for your platform (ops I-1343: Playwright
# 1.64.1 bundles 156 and passes on 157.0.8103.38 and 157.0.8103.50).
set -eu

VERSION=157.0.8103.50
SHA256=7bf0d41e424efd1d6281c4162993ab9dc5de92fac213c211614905a71c057d0f

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

#!/bin/sh
# Points apt at Debian's HTTPS sources and installs the fixed apt, for both images (Dockerfile, Dockerfile.video),
# before their first apt-get (ops I-1152). Debian's images list http://deb.debian.org, and over plain HTTP a
# man-in-the-middle can swap a package after apt verifies it (CVE-2026-109518; fixed in bookworm's apt 2.6.2, in
# the security archive).
#
# node:24.22.1-slim ships no CA bundle, and apt's HTTPS needs one. Until Debian's ca-certificates package installs
# the system bundle, apt trusts Node's bundled Mozilla roots: the same ones npm ci trusts in this build.
set -eu

find /etc/apt -type f \( -name '*.list' -o -name '*.sources' \) -exec sed -i 's|http://|https://|g' {} +

# apt's download methods run as the _apt user, so the roots file must be world-readable
roots=/tmp/node-roots.pem
node -e "process.stdout.write(require('tls').rootCertificates.join('\n') + '\n')" > "$roots"
chmod 0644 "$roots"
apt-get -o Acquire::https::CaInfo="$roots" update
apt-get -o Acquire::https::CaInfo="$roots" install -y --only-upgrade apt
apt-get -o Acquire::https::CaInfo="$roots" install -y --no-install-recommends ca-certificates
rm -f "$roots"
rm -rf /var/lib/apt/lists/*

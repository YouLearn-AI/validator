# validator
Server used to expose validation endpoints for nodejs specific libraries.

Renders run in Google Chrome stable through Playwright's `chrome` channel (ops I-1114), at the build
`install-chrome.sh` pins in the images. Tests and local runs need Google Chrome installed
(`npx playwright install chrome` installs it).

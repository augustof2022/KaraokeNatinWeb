# Browser app provenance

This directory contains the standalone browser version of KaraokeNatin by
[nojukuramu](https://github.com/nojukuramu), imported from:

- Repository: https://github.com/nojukuramu/nojukuramu.github.io
- Directory: `karaokenatin/`
- Commit: `9b7dfea901ece9d1736c18f016de9eef54c216af`
- Original live site: https://nojukuramu.github.io/karaokenatin/

The desktop application in this repository is forked from
[nojukuramu/KaraokeNatin](https://github.com/nojukuramu/KaraokeNatin).
Original source comments and upstream credit are retained.

Fork changes:

- Deploy the browser app at https://augustof2022.github.io/KaraokeNatinWeb/.
- Link the app's source footer and documentation to this fork.
- Use a relative PWA manifest identity so installation uses this site's path.
- Add optional host YouTube sign-in guidance without changing account or playback handling.
- Confirm room closure inside the app and ignore stale player/network callbacks after leaving.
- Publish only static runtime assets through `.github/workflows/pages.yml`.

The upstream browser code and the native app have separate implementations.
Updating the native app does not automatically update this directory; compare
against the recorded browser revision when importing future changes.

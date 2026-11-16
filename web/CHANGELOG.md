# Changelog — website

Every change to the published site at https://augustof2022.github.io/KaraokeNatinWeb/
gets a new version, fixes included. The version is shown in the site's footer, so
anyone can tell whether a fix has reached their phone or TV: if the footer shows a
version listed here, that device has everything up to and including it. Tap
**Check for updates** in the footer to fetch the newest version.

How to release a change: see "Versioning" in [README.md](README.md#versioning).

Versions follow [Semantic Versioning](https://semver.org/): **patch** (2.6.10 → 2.6.11)
for fixes, **minor** (2.6 → 2.7) for new features, **major** for changes that break
existing rooms or saved data.

## [2.6.11] - 2026-11-16

### Fixed
- **Joining a room no longer asks you to retry straight away.** While a phone is
  still connecting, the "Joining the room" screen shows a mic-and-music-notes
  animation and the current step. **Retry now** appears only once the join is
  clearly stuck: three failed attempts in a row, 15 seconds without success, or
  the phone being offline. It keeps retrying on its own the whole time.
  **Leave room** stays available so a guest can always back out.

### Added
- This changelog, and a CI check that every change to the site raises the version.

## [2.6.10]

The version live when this changelog was started. Earlier changes are in the git
history of `web/`.

/* tools/bump-version.js — raise the website's version in every place it lives.
 *
 * The version appears in js/app.js (APP_VERSION, shown in the footer),
 * sw.js (ASSET_V, which makes installed copies pick up the new build) and as
 * ?v=… on every stylesheet and script in index.html. tools/version-check.js
 * fails if they disagree; this keeps them agreeing.
 *
 * It also opens a section for the new version at the top of CHANGELOG.md,
 * for you to fill in. CI (tools/version-bump-check.js) refuses a pull request
 * that changes the website without a new version and a changelog entry.
 *
 * Run from web/:
 *   node tools/bump-version.js patch    2.6.10 → 2.6.11  (fixes)
 *   node tools/bump-version.js minor    2.6.10 → 2.7.0   (new features)
 *   node tools/bump-version.js major    2.6.10 → 3.0.0
 *   node tools/bump-version.js 2.8.0    an exact version
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const file = (f) => path.join(ROOT, f);
const read = (f) => fs.readFileSync(file(f), "utf8");
const write = (f, s) => fs.writeFileSync(file(f), s);

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function currentVersion() {
  const m = read("js/app.js").match(/APP_VERSION\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("js/app.js has no APP_VERSION");
  return m[1];
}

function nextVersion(current, how) {
  if (SEMVER.test(how)) return how;
  const m = current.match(SEMVER);
  if (!m) throw new Error("current version " + current + " is not x.y.z");
  let [major, minor, patch] = m.slice(1).map(Number);
  if (how === "major") { major++; minor = 0; patch = 0; }
  else if (how === "minor") { minor++; patch = 0; }
  else if (how === "patch") { patch++; }
  else throw new Error('expected "patch", "minor", "major" or x.y.z, got "' + how + '"');
  return major + "." + minor + "." + patch;
}

function replaceExact(f, pattern, replacement, expectAtLeast) {
  const before = read(f);
  let count = 0;
  const after = before.replace(pattern, function () { count++; return replacement.apply(null, arguments); });
  if (count < expectAtLeast) throw new Error(f + ": expected to update at least " + expectAtLeast + " place(s), found " + count);
  write(f, after);
  return count;
}

function main() {
  const how = process.argv[2];
  if (!how) {
    console.error("usage: node tools/bump-version.js patch|minor|major|x.y.z");
    process.exit(2);
  }
  const from = currentVersion();
  const to = nextVersion(from, how);
  if (to === from) { console.error("already at " + to); process.exit(1); }

  replaceExact("js/app.js", /(APP_VERSION\s*=\s*")[^"]+(")/, (_, a, b) => a + to + b, 1);
  replaceExact("sw.js", /(ASSET_V\s*=\s*")[^"]+(")/, (_, a, b) => a + to + b, 1);
  const refs = replaceExact("index.html", /((?:href|src)="(?:css|js)\/[^"?]+)\?v=[^"]+"/g, (_, a) => a + "?v=" + to + '"', 1);

  // Open a changelog section for the new version, unless one already exists.
  const changelog = read("CHANGELOG.md");
  if (!changelog.includes("## [" + to + "]")) {
    const today = new Date().toISOString().slice(0, 10);
    const section = "## [" + to + "] - " + today + "\n\n### Fixed\n- \n\n";
    const at = changelog.indexOf("\n## [");
    if (at === -1) throw new Error("CHANGELOG.md has no existing ## [x.y.z] section to insert above");
    write("CHANGELOG.md", changelog.slice(0, at + 1) + section + changelog.slice(at + 1));
  }

  console.log("website version " + from + " → " + to);
  console.log("  js/app.js APP_VERSION, sw.js ASSET_V, " + refs + " asset URLs in index.html");
  console.log("  CHANGELOG.md: describe what changed under ## [" + to + "]");
}

main();

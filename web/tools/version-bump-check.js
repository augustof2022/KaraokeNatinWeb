/* tools/version-bump-check.js — every change to the website ships as a new version.
 *
 * The footer's version number is how anyone can tell which build their phone
 * or TV is running, and whether a fix has reached it. That only works if the
 * number moves every time the shipped site changes — fixes included.
 *
 * Given the commit a pull request is based on, this fails when the PR changes
 * any file the site ships (index.html, sw.js, the manifest, css/, js/,
 * icons/) without both:
 *   - a higher version than the base (tools/bump-version.js does this), and
 *   - a CHANGELOG.md section for that version with at least one entry.
 *
 * Run from web/:  node tools/version-bump-check.js <base-commit>
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const WEB = path.resolve(__dirname, "..");
const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: WEB, encoding: "utf8" }).trim();
const git = (args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" });

// Paths relative to web/ that end up on the published site.
const SHIPPED = [/^index\.html$/, /^sw\.js$/, /^manifest\.webmanifest$/, /^css\//, /^js\//, /^icons\//];

const versionIn = (source) => (source.match(/APP_VERSION\s*=\s*"([^"]+)"/) || [])[1];

function compare(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function main() {
  const base = process.argv[2];
  if (!base) { console.error("usage: node tools/version-bump-check.js <base-commit>"); process.exit(2); }

  const changed = git(["diff", "--name-only", base + "...HEAD", "--", "web/"])
    .split("\n").filter(Boolean).map((f) => f.replace(/^web\//, ""));
  const shipped = changed.filter((f) => SHIPPED.some((re) => re.test(f)));
  if (!shipped.length) {
    console.log("The website's shipped files are unchanged; no new version needed.");
    return;
  }
  console.log("Website files changed:\n  " + shipped.join("\n  "));

  const from = versionIn(git(["show", base + ":web/js/app.js"]));
  const to = versionIn(fs.readFileSync(path.join(WEB, "js/app.js"), "utf8"));
  const problems = [];

  if (!from || !to) problems.push("could not read APP_VERSION (base: " + from + ", this PR: " + to + ")");
  else if (compare(to, from) <= 0) {
    problems.push("the version is still " + to + " (base has " + from + "). Raise it:\n" +
      "      cd web && node tools/bump-version.js patch   # or minor / major");
  }

  if (to) {
    const changelog = fs.readFileSync(path.join(WEB, "CHANGELOG.md"), "utf8");
    const start = changelog.indexOf("## [" + to + "]");
    if (start === -1) {
      problems.push("CHANGELOG.md has no \"## [" + to + "]\" section describing this version");
    } else {
      const next = changelog.indexOf("\n## [", start + 1);
      const body = changelog.slice(start, next === -1 ? undefined : next);
      if (!/^\s*[-*]\s+\S/m.test(body)) problems.push("CHANGELOG.md's ## [" + to + "] section has no entries yet");
    }
  }

  if (problems.length) {
    console.error("\nThis pull request changes the website but:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  console.log("\nVersion " + from + " → " + to + ", with a changelog entry.");
}

main();

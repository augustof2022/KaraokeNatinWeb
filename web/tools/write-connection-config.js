"use strict";
const fs = require("node:fs");
const endpoint = process.env.TURN_CREDENTIALS_URL || "";
if (endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error("TURN_CREDENTIALS_URL must be a public HTTPS endpoint without credentials or query parameters");
  }
}
if (!process.argv[2]) throw new Error("Output path is required");
fs.writeFileSync(process.argv[2], "// Public credential-service URL; API secrets stay on the service.\nwindow.KN_TURN_ENDPOINT = " + JSON.stringify(endpoint) + ";\n");

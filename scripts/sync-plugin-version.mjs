#!/usr/bin/env node
// Keep the Claude Code plugin version in lockstep with the package version.
// The plugin cache is keyed on this version: if it never changes, installed
// plugins never pick up skill updates shipped in a release.
//
// Runs after `changeset version` (see the "version" script in package.json).
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const rootDirPath = url.fileURLToPath(new URL("..", import.meta.url));
const packageFilePath = path.join(rootDirPath, "package.json");
const marketplaceFilePath = path.join(rootDirPath, ".claude-plugin", "marketplace.json");

const packageVersion = JSON.parse(fs.readFileSync(packageFilePath, "utf8")).version;
const marketplaceFileContent = fs.readFileSync(marketplaceFilePath, "utf8");

// String replacement rather than JSON.stringify to preserve the file's
// formatting. The file has a single "version" key.
const syncedMarketplaceFileContent = marketplaceFileContent.replace(
  /"version": "[^"]*"/,
  `"version": "${packageVersion}"`,
);

if (!syncedMarketplaceFileContent.includes(`"version": "${packageVersion}"`)) {
  console.error(`sync-plugin-version: no "version" field found in ${marketplaceFilePath}`);
  process.exit(1);
}

fs.writeFileSync(marketplaceFilePath, syncedMarketplaceFileContent);
console.log(`Synced .claude-plugin/marketplace.json to ${packageVersion}`);

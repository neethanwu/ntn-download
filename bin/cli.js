#!/usr/bin/env node

// Node version check — must run before any ESM imports
const [major, minor] = process.version.slice(1).split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(
    `\nnotion-download requires Node.js 20.12 or later.\n` +
    `You are running ${process.version}.\n\n` +
    `Download the latest version from: https://nodejs.org\n`
  );
  process.exit(1);
}

// Launch the CLI
import('../src/cli.js');

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';

const FOLDER_NAME = 'notion-export';

/**
 * Get the default save path based on the OS.
 */
export function getDefaultSavePath() {
  return path.join(os.homedir(), 'Desktop', FOLDER_NAME);
}

/**
 * Build a list of common save locations that exist on this machine.
 * Adapts to the current OS — only shows folders that exist.
 */
export function getSaveLocationOptions() {
  const home = os.homedir();
  const isWindows = process.platform === 'win32';

  const candidates = [
    { dir: path.join(home, 'Desktop'), label: 'Desktop' },
    { dir: path.join(home, 'Documents'), label: 'Documents' },
    { dir: path.join(home, 'Downloads'), label: 'Downloads' },
  ];

  // Windows: OneDrive often redirects Desktop/Documents
  if (isWindows) {
    candidates.push(
      { dir: path.join(home, 'OneDrive', 'Desktop'), label: 'OneDrive Desktop' },
      { dir: path.join(home, 'OneDrive', 'Documents'), label: 'OneDrive Documents' },
    );
  }

  candidates.push(
    { dir: home, label: 'Home folder' },
    { dir: process.cwd(), label: 'Current folder' },
  );

  // Deduplicate by resolved path
  const seen = new Set();
  const options = [];

  for (const c of candidates) {
    const resolved = path.resolve(c.dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    if (!existsSync(resolved)) continue;

    const full = path.join(resolved, FOLDER_NAME);
    options.push({
      value: full,
      label: c.label,
      hint: shortenPath(full, home),
    });
  }

  options.push({
    value: 'custom',
    label: 'Other location',
    hint: 'type a custom path',
  });

  return options;
}

/**
 * Shorten a path for display by replacing the home directory with ~.
 */
function shortenPath(fullPath, home) {
  if (fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}

/**
 * Check if a path is writable (or its parent is writable for new dirs).
 */
export async function isWritablePath(targetPath) {
  // If the path itself exists, check if it's writable
  if (existsSync(targetPath)) {
    try {
      await access(targetPath, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  // Check parent directory
  const parent = path.dirname(targetPath);
  if (!existsSync(parent)) return false;

  try {
    await access(parent, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Characters invalid in Windows filenames
const INVALID_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

// Windows reserved device names
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Sanitize a string for use as a filename on any OS.
 * Strips invalid characters, handles reserved names,
 * trims trailing dots/spaces, and truncates to maxLength.
 */
export function sanitizeFilename(title, maxLength = 200) {
  if (!title || !title.trim()) {
    return 'Untitled';
  }

  let name = title
    .replace(INVALID_CHARS, '')  // Remove invalid chars
    .replace(/\s+/g, '-')       // Replace whitespace with hyphens (link-friendly)
    .replace(/-{2,}/g, '-')     // Collapse multiple hyphens
    .replace(/^-|-$/g, '')      // Trim leading/trailing hyphens
    .replace(/[.]+$/, '');       // Trim trailing dots (Windows issue)

  if (!name || /^\.{1,2}$/.test(name)) {
    return 'Untitled';
  }

  // Handle Windows reserved names
  const upperName = name.split('.')[0].toUpperCase();
  if (RESERVED_NAMES.has(upperName)) {
    name = `_${name}`;
  }

  // Truncate
  if (name.length > maxLength) {
    name = name.slice(0, maxLength).trim();
  }

  return name;
}

/**
 * Generate a unique filename among existing names.
 * If "Meeting Notes" already exists, returns "Meeting Notes (2)", etc.
 */
export function uniqueFilename(name, existingNames) {
  if (!existingNames.has(name)) {
    existingNames.add(name);
    return name;
  }

  let counter = 2;
  while (existingNames.has(`${name} (${counter})`)) {
    counter++;
  }
  const unique = `${name} (${counter})`;
  existingNames.add(unique);
  return unique;
}

/**
 * Recursively create a directory if it doesn't exist.
 */
export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

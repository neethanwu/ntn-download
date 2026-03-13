import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Get the default save path based on the OS.
 * Always resolves to ~/Desktop/notion-export.
 */
export function getDefaultSavePath() {
  return path.join(os.homedir(), 'Desktop', 'notion-export');
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
    .replace(/\s+/g, ' ')       // Collapse whitespace
    .trim()
    .replace(/[. ]+$/, '');      // Trim trailing dots and spaces (Windows issue)

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

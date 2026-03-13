import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.notion-to-fs');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Load saved config. Returns { token, workspace } or null if none/invalid.
 */
export async function loadConfig() {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    // Validate shape — token must be a string if present
    if (parsed && typeof parsed === 'object' && typeof parsed.token === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save config to ~/.notion-to-fs/config.json.
 * Directory and file are created with restrictive permissions from the start.
 */
export async function saveConfig(config) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

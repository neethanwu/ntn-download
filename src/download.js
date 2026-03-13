import { NotionToMarkdown } from 'notion-to-md';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeFilename, uniqueFilename, ensureDir } from './utils.js';
import { extractTitle } from './notion.js';

const MAX_DEPTH = 20;
const DOWNLOAD_TIMEOUT_MS = 60_000;

// Block private/internal IP ranges to prevent SSRF
const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const PRIVATE_IP_PREFIXES = ['10.', '192.168.', '169.254.', '172.16.', '172.17.', '172.18.',
  '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.',
  '172.27.', '172.28.', '172.29.', '172.30.', '172.31.'];

/**
 * Download selected pages/databases to the local filesystem.
 *
 * Callbacks:
 *   onStatus(message)  – spinner/progress text (frequently updated)
 *   onLog(message)     – milestone log line (page saved, db started, etc.)
 *   onError(message)   – error log line (shown immediately, not batched)
 */
export async function downloadPages(selectedItems, savePath, notion, { onStatus, onLog, onError }) {
  await ensureDir(savePath);

  const n2m = new NotionToMarkdown({
    notionClient: notion.client,
    config: {
      separateChildPage: true,
      parseChildPages: false,
    },
  });

  const stats = { totalPages: 0, totalAssets: 0, errors: [] };
  const ctx = { notion, n2m, stats, onStatus, onLog, onError };
  const usedNames = new Set();
  const visited = new Set();

  for (let i = 0; i < selectedItems.length; i++) {
    const item = selectedItems[i];
    const safeName = uniqueFilename(sanitizeFilename(item.title), usedNames);
    const prefix = `[${i + 1}/${selectedItems.length}]`;

    onLog(`${prefix} Starting: ${item.title}`);

    try {
      if (item.type === 'database') {
        await downloadDatabase(item.id, safeName, savePath, ctx, visited, 0);
      } else {
        await downloadPage(item.id, safeName, savePath, ctx, visited, 0);
      }
      onLog(`${prefix} Done: ${item.title} (${stats.totalPages} pages, ${stats.totalAssets} assets so far)`);
    } catch (err) {
      stats.errors.push({ title: item.title, error: err.message });
      onError(`${prefix} Failed: ${item.title} — ${err.message}`);
    }
  }

  return stats;
}

/**
 * Recursively download a single page and its children.
 * Fetches blocks once through the throttled API wrapper, then:
 *   1. Passes them to notion-to-md for markdown conversion (no extra API calls)
 *   2. Extracts child_page/child_database blocks for recursion
 */
async function downloadPage(pageId, name, parentDir, ctx, visited, depth) {
  if (visited.has(pageId)) return;
  if (depth > MAX_DEPTH) {
    ctx.stats.errors.push({ title: name, error: `Skipped: exceeded max depth of ${MAX_DEPTH}` });
    return;
  }
  visited.add(pageId);

  const { notion, n2m, stats, onStatus, onError } = ctx;
  const pageDir = path.join(parentDir, name);
  await ensureDir(pageDir);

  onStatus(`Fetching: ${name}`);

  // Fetch blocks ONCE through our throttled wrapper
  let blocks;
  try {
    blocks = await notion.getBlockChildren(pageId);
  } catch (err) {
    const mdPath = path.join(pageDir, `${name}.md`);
    await writeFile(mdPath, `# ${name}\n`, 'utf-8');
    stats.totalPages++;
    stats.errors.push({ title: name, error: `Could not fetch blocks: ${err.message}` });
    onError(`Could not fetch: ${name} — ${err.message}`);
    return;
  }

  onStatus(`Converting: ${name} (${blocks.length} blocks)`);

  // Split blocks into segments at child_page/child_database boundaries,
  // convert each segment separately, and interleave child links to preserve order
  const childNames = new Set();
  const childEntries = [];
  const markdownParts = [];
  let currentSegment = [];

  for (const block of blocks) {
    if (block.type === 'child_page') {
      // Flush current segment
      if (currentSegment.length > 0) {
        markdownParts.push({ type: 'blocks', blocks: currentSegment });
        currentSegment = [];
      }
      const childTitle = block.child_page?.title || 'Untitled';
      const childName = uniqueFilename(sanitizeFilename(childTitle), childNames);
      childEntries.push({ block, title: childTitle, name: childName, type: 'page' });
      markdownParts.push({ type: 'link', title: childTitle, name: childName, childType: 'page' });
    } else if (block.type === 'child_database') {
      if (currentSegment.length > 0) {
        markdownParts.push({ type: 'blocks', blocks: currentSegment });
        currentSegment = [];
      }
      const dbTitle = block.child_database?.title || 'Untitled Database';
      const dbName = uniqueFilename(sanitizeFilename(dbTitle), childNames);
      childEntries.push({ block, title: dbTitle, name: dbName, type: 'database' });
      markdownParts.push({ type: 'link', title: dbTitle, name: dbName, childType: 'database' });
    } else {
      currentSegment.push(block);
    }
  }
  if (currentSegment.length > 0) {
    markdownParts.push({ type: 'blocks', blocks: currentSegment });
  }

  // Build markdown by converting each segment and inserting links inline
  let markdown = `# ${name}\n\n`;

  for (const part of markdownParts) {
    if (part.type === 'link') {
      const relativePath = `./${part.name}/${part.name}.md`;
      markdown += `- [${part.title}](${relativePath})\n`;
    } else {
      try {
        const mdBlocks = await n2m.blocksToMarkdown(part.blocks);
        const mdResult = n2m.toMarkdownString(mdBlocks);
        const segment = mdResult.parent || '';
        if (segment.trim()) {
          markdown += segment;
          if (!markdown.endsWith('\n\n')) {
            markdown += '\n';
          }
        }
      } catch {
        // Skip failed segments
      }
    }
  }

  if (!markdown.trim()) {
    markdown = `# ${name}\n`;
  }

  markdown = await processAssets(markdown, pageDir, stats, ctx);

  const mdPath = path.join(pageDir, `${name}.md`);
  await writeFile(mdPath, markdown, 'utf-8');
  stats.totalPages++;

  // Now recurse into children
  if (childEntries.length > 0) {
    const pageCount = childEntries.filter((e) => e.type === 'page').length;
    const dbCount = childEntries.filter((e) => e.type === 'database').length;
    onStatus(`${name}: ${pageCount} sub-pages, ${dbCount} sub-databases`);
  }

  for (const entry of childEntries) {
    try {
      if (entry.type === 'page') {
        await downloadPage(entry.block.id, entry.name, pageDir, ctx, visited, depth + 1);
      } else {
        await downloadDatabase(entry.block.id, entry.name, pageDir, ctx, visited, depth + 1);
      }
    } catch (err) {
      stats.errors.push({ title: entry.title, error: err.message });
      onError(`Failed: ${entry.title} — ${err.message}`);
    }
  }
}

/**
 * Download a database: create a folder and download each row as a page.
 */
async function downloadDatabase(databaseId, name, parentDir, ctx, visited, depth) {
  if (visited.has(databaseId)) return;
  visited.add(databaseId);

  const { notion, n2m, stats, onStatus, onLog, onError } = ctx;
  const dbDir = path.join(parentDir, name);
  await ensureDir(dbDir);

  onStatus(`Querying database: ${name}`);

  let rows;
  try {
    rows = await notion.queryDatabase(databaseId);
  } catch (err) {
    stats.errors.push({ title: name, error: `Could not query database: ${err.message}` });
    onError(`Could not query database: ${name} — ${err.message}`);
    return;
  }

  onLog(`Database "${name}": ${rows.length} row${rows.length === 1 ? '' : 's'}`);

  const rowNames = new Set();
  const rowLinks = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowTitle = extractTitle(row);
    const rowName = uniqueFilename(sanitizeFilename(rowTitle), rowNames);

    onStatus(`${name}: row ${i + 1}/${rows.length} — ${rowTitle}`);
    rowLinks.push({ title: rowTitle, name: rowName });

    try {
      const frontmatter = buildFrontmatter(row.properties);
      const rowDir = path.join(dbDir, rowName);
      await ensureDir(rowDir);

      // Fetch blocks through throttled wrapper, then convert
      let blocks;
      try {
        blocks = await notion.getBlockChildren(row.id);
      } catch {
        blocks = [];
      }

      let mdBlocks;
      try {
        mdBlocks = await n2m.blocksToMarkdown(blocks);
      } catch {
        mdBlocks = [];
      }

      let mdResult;
      try {
        mdResult = n2m.toMarkdownString(mdBlocks);
      } catch {
        mdResult = { parent: '' };
      }

      let markdown = mdResult.parent || '';

      let content = '';
      if (frontmatter) {
        content += `---\n${frontmatter}---\n\n`;
      }
      content += `# ${rowName}\n\n${markdown}`;

      content = await processAssets(content, rowDir, stats, ctx);

      const mdPath = path.join(rowDir, `${rowName}.md`);
      await writeFile(mdPath, content, 'utf-8');
      stats.totalPages++;
    } catch (err) {
      stats.errors.push({ title: rowTitle, error: err.message });
      onError(`Row failed: ${rowTitle} — ${err.message}`);
    }
  }

  // Create database index file listing all rows
  const indexLines = [`# ${name}\n`];
  for (const row of rowLinks) {
    indexLines.push(`- [${row.title}](./${row.name}/${row.name}.md)`);
  }
  const indexPath = path.join(dbDir, `${name}.md`);
  await writeFile(indexPath, indexLines.join('\n') + '\n', 'utf-8');
}

/**
 * Find and download all images/files in markdown content.
 * Rewrites URLs to relative ./assets/ paths using a single-pass replacement.
 */
async function processAssets(markdown, pageDir, stats, ctx) {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const assetsDir = path.join(pageDir, 'assets');
  let assetsCreated = false;
  const usedAssetNames = new Set();

  const replacements = new Map();
  const downloads = [];

  let match;
  while ((match = imageRegex.exec(markdown)) !== null) {
    const [full, alt, url] = match;

    if (url.startsWith('data:') || !url.startsWith('http')) continue;
    if (!isAllowedUrl(url)) continue;

    const filename = getAssetFilename(url, usedAssetNames);
    downloads.push({ url, fullMatch: full, alt, filename });
  }

  if (downloads.length === 0) return markdown;

  if (ctx) {
    ctx.onStatus(`Downloading ${downloads.length} asset${downloads.length === 1 ? '' : 's'}...`);
  }

  for (let i = 0; i < downloads.length; i++) {
    const dl = downloads[i];
    try {
      if (!assetsCreated) {
        await ensureDir(assetsDir);
        assetsCreated = true;
      }

      if (ctx) {
        ctx.onStatus(`Asset ${i + 1}/${downloads.length}: ${dl.filename}`);
      }

      const assetPath = path.join(assetsDir, dl.filename);
      await downloadFile(dl.url, assetPath);
      stats.totalAssets++;

      replacements.set(dl.fullMatch, `![${dl.alt}](./assets/${dl.filename})`);
    } catch (err) {
      if (ctx) {
        ctx.onError(`Asset failed: ${dl.filename} — ${err.message}`);
      }
      // Leave original URL if download fails
    }
  }

  if (replacements.size === 0) return markdown;

  return markdown.replace(imageRegex, (match) => {
    return replacements.get(match) || match;
  });
}

/**
 * Check if a URL is safe to fetch (not a private/internal address).
 */
function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    if (BLOCKED_HOSTNAMES.has(hostname)) return false;
    if (PRIVATE_IP_PREFIXES.some((prefix) => hostname.startsWith(prefix))) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Download a file from a URL to a local path with timeout.
 */
async function downloadFile(url, destPath) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);
}

/**
 * Extract a suitable filename from a URL.
 */
function getAssetFilename(url, usedNames) {
  try {
    const parsed = new URL(url);
    let filename = parsed.pathname.split('/').pop() || 'file';

    if (!path.extname(filename)) {
      filename += '.png';
    }

    filename = filename.replace(/[<>:"/\\|?*]/g, '');

    if (usedNames.has(filename)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      let counter = 2;
      while (usedNames.has(`${base}-${counter}${ext}`)) {
        counter++;
      }
      filename = `${base}-${counter}${ext}`;
    }

    usedNames.add(filename);
    return filename;
  } catch {
    const fallback = `asset-${usedNames.size + 1}.png`;
    usedNames.add(fallback);
    return fallback;
  }
}

/**
 * Build YAML frontmatter from database page properties.
 * All string values are properly quoted to prevent YAML injection.
 */
function buildFrontmatter(properties) {
  if (!properties) return '';

  const lines = [];

  for (const [key, prop] of Object.entries(properties)) {
    if (prop.type === 'title') continue;

    const value = extractPropertyValue(prop);
    if (value !== null) {
      const safeKey = /[:#{}[\],&*?|>!%@`]/.test(key) ? `"${escapeYaml(key)}"` : key;
      lines.push(`${safeKey}: ${value}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

function escapeYaml(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function yamlString(val) {
  if (val === null || val === undefined) return null;
  return `"${escapeYaml(String(val))}"`;
}

function extractPropertyValue(prop) {
  switch (prop.type) {
    case 'rich_text': {
      const text = prop.rich_text?.map((t) => t.plain_text).join('');
      return text ? yamlString(text) : null;
    }
    case 'number':
      return prop.number;
    case 'select':
      return prop.select?.name ? yamlString(prop.select.name) : null;
    case 'multi_select':
      if (!prop.multi_select?.length) return null;
      return `[${prop.multi_select.map((s) => yamlString(s.name)).join(', ')}]`;
    case 'date':
      if (!prop.date) return null;
      return prop.date.end
        ? yamlString(`${prop.date.start} → ${prop.date.end}`)
        : yamlString(prop.date.start);
    case 'checkbox':
      return prop.checkbox;
    case 'url':
      return prop.url ? yamlString(prop.url) : null;
    case 'email':
      return prop.email ? yamlString(prop.email) : null;
    case 'phone_number':
      return prop.phone_number ? yamlString(prop.phone_number) : null;
    case 'status':
      return prop.status?.name ? yamlString(prop.status.name) : null;
    default:
      return null;
  }
}

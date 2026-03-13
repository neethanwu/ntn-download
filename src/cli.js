import * as p from '@clack/prompts';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { NotionClient } from './notion.js';
import { loadConfig, saveConfig } from './config.js';
import { getSaveLocationOptions, isWritablePath } from './utils.js';
import { downloadPages } from './download.js';

/** Exit cleanly if the user cancels a prompt. */
function exitIfCancelled(value) {
  if (p.isCancel(value)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  return value;
}

const BANNER = `
██████╗  █████╗  ██████╗ ███████╗███████╗
██╔══██╗██╔══██╗██╔════╝ ██╔════╝██╔════╝
██████╔╝███████║██║  ███╗█████╗  ███████╗
██╔═══╝ ██╔══██║██║   ██║██╔══╝  ╚════██║
██║     ██║  ██║╚██████╔╝███████╗███████║
╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚══════╝
██████╗  ██████╗ ██╗    ██╗███╗   ██╗
██╔══██╗██╔═══██╗██║    ██║████╗  ██║
██║  ██║██║   ██║██║ █╗ ██║██╔██╗ ██║
██║  ██║██║   ██║██║███╗██║██║╚██╗██║
██████╔╝╚██████╔╝╚███╔███╔╝██║ ╚████║
╚═════╝  ╚═════╝  ╚══╝╚══╝ ╚═╝  ╚═══╝
`;

async function main() {
  console.log(BANNER);
  p.intro('pagesdown v0.1.1');

  // ── Step 1: Token ─────────────────────────────────────────────────
  let token = null;
  let workspaceName = null;

  const savedConfig = await loadConfig();

  if (savedConfig?.token) {
    const useSaved = exitIfCancelled(
      await p.confirm({
        message: `Use saved token${savedConfig.workspace ? ` for "${savedConfig.workspace}"` : ''}?`,
      })
    );

    if (useSaved) {
      token = savedConfig.token;
      workspaceName = savedConfig.workspace;
    }
  }

  if (!token) {
    p.note(
      [
        '1. Open: https://www.notion.so/profile/integrations/internal/form/new-integration',
        '2. Fill in a name (e.g. "export-to-fs"), select your workspace',
        '   Note: the name cannot contain the word "notion"',
        '3. Under Capabilities:',
        '   - Content: check only "Read content", uncheck the rest',
        '   - Comments: uncheck all',
        '   - User capabilities: select "No user information"',
        '4. Click "Create" → copy the "Internal Integration Secret"',
      ].join('\n'),
      'Step 1: Create a Notion integration'
    );

    token = exitIfCancelled(
      await p.password({
        message: 'Paste your integration token:',
        validate: (val) => {
          if (!val) return 'Token is required.';
          if (!val.startsWith('ntn_') && !val.startsWith('secret_')) {
            return 'Token should start with "ntn_" (or "secret_" for older tokens).';
          }
        },
      })
    );
  }

  // ── Step 2: Validate token ────────────────────────────────────────
  const spin = p.spinner();
  spin.start('Connecting to Notion...');

  const notion = new NotionClient(token);

  try {
    await notion.validateToken();
    spin.stop('Connected to Notion.');
  } catch (err) {
    spin.stop('Connection failed.');
    p.log.error(
      err.status === 401
        ? 'Invalid token. Make sure you copied the "Internal Integration Secret", not the Integration ID.'
        : 'Could not connect to Notion. Check your internet connection and try again.'
    );
    process.exit(1);
  }

  // ── Step 3: Share pages with integration ──────────────────────────
  if (!savedConfig?.token || savedConfig.token !== token) {
    p.note(
      [
        'Now share ALL the pages you want to download:',
        '',
        '  1. Open a page in Notion',
        '  2. Click the ••• menu at the top right',
        '  3. Select "Connections"',
        '  4. Add your integration',
        '',
        'Repeat for each top-level page or database you want.',
        'Sharing a parent page automatically shares all its children.',
        '',
        'Don\'t worry if you miss some — you can add more later.',
      ].join('\n'),
      'Step 2: Share pages with your integration'
    );

    exitIfCancelled(
      await p.confirm({
        message: 'I\'ve shared my pages. Continue?',
      })
    );
  }

  // ── Step 3: Fetch & select pages (with refresh loop) ──────────────
  let selected;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    spin.start('Fetching your pages...');

    let topLevelItems;
    try {
      topLevelItems = await notion.getTopLevelPages();
    } catch (err) {
      spin.stop('Failed to fetch pages.');
      p.log.error(`Error: ${err.message}`);
      process.exit(1);
    }

    spin.stop(`Found ${topLevelItems.length} top-level item${topLevelItems.length === 1 ? '' : 's'}.`);

    if (topLevelItems.length === 0) {
      p.log.warn('No pages found. Make sure you\'ve shared at least one page with your integration.');

      const retry = exitIfCancelled(
        await p.confirm({
          message: 'Share some pages in Notion, then try again?',
        })
      );

      if (!retry) {
        p.cancel('No pages to download.');
        process.exit(0);
      }
      continue;
    }

    const options = topLevelItems.map((item) => ({
      value: item,
      label: item.title,
      hint: item.type === 'database' ? 'database' : undefined,
    }));

    p.log.info('Hint: arrows move, space toggle, enter confirm');

    selected = exitIfCancelled(
      await p.multiselect({
        message: 'Select pages to download:',
        options,
        initialValues: topLevelItems,
        required: true,
      })
    );

    const looksGood = exitIfCancelled(
      await p.confirm({
        message: 'Look good? (No = share more pages in Notion and refresh the list)',
      })
    );

    if (!looksGood) {
      p.log.info('Go to Notion and share more pages with your integration.');
      exitIfCancelled(
        await p.confirm({ message: 'Done sharing? Press Enter to refresh.' })
      );
      continue;
    }

    break;
  }

  // ── Step 5: Save location ─────────────────────────────────────────
  const locationOptions = getSaveLocationOptions();

  let savePath;

  const locationChoice = exitIfCancelled(
    await p.select({
      message: 'Where should we save the files?',
      options: locationOptions,
    })
  );

  if (locationChoice === 'custom') {
    const rawPath = exitIfCancelled(
      await p.text({
        message: 'Enter the full path:',
        validate: (val) => {
          if (!val?.trim()) return 'Path is required.';
        },
      })
    );
    savePath = path.resolve(rawPath);
  } else {
    savePath = locationChoice;
  }

  // Validate the path is writable
  if (!(await isWritablePath(savePath))) {
    p.log.error(`Cannot write to "${savePath}". Check that the folder exists and you have permission.`);
    process.exit(1);
  }

  // Inform user about merge behavior if directory exists
  if (existsSync(savePath)) {
    p.log.info(`"${savePath}" already exists. New pages will be added, existing pages will be updated.`);
  }

  // ── Step 6: Confirm & Download ────────────────────────────────────
  const proceed = exitIfCancelled(
    await p.confirm({
      message: `Download ${selected.length} item${selected.length === 1 ? '' : 's'} to ${savePath}?`,
    })
  );

  if (!proceed) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  // Save token for future use (if it's a new token)
  if (!savedConfig?.token || savedConfig.token !== token) {
    const shouldSave = exitIfCancelled(
      await p.confirm({
        message: 'Save token for future use? (stored in ~/.pagesdown/config.json)',
      })
    );

    if (shouldSave) {
      await saveConfig({ token, workspace: workspaceName });
      p.log.success('Token saved.');
    }
  }

  // ── Download ──────────────────────────────────────────────────────
  spin.start('Starting download...');

  const stats = await downloadPages(selected, savePath, notion, {
    onStatus: (message) => spin.message(message),
    onLog: (message) => {
      spin.stop(message);
      spin.start('...');
    },
    onError: (message) => {
      spin.stop('');
      p.log.warn(message);
      spin.start('Continuing...');
    },
  });

  spin.stop(`${stats.totalPages} page${stats.totalPages === 1 ? '' : 's'}, ${stats.totalAssets} asset${stats.totalAssets === 1 ? '' : 's'} downloaded.`);

  // ── Summary ───────────────────────────────────────────────────────
  const summary = [`${stats.totalPages} page${stats.totalPages === 1 ? '' : 's'} downloaded`];
  if (stats.totalAssets > 0) {
    summary.push(`${stats.totalAssets} file${stats.totalAssets === 1 ? '' : 's'} saved`);
  }
  if (stats.errors.length > 0) {
    summary.push(`${stats.errors.length} error${stats.errors.length === 1 ? '' : 's'}`);
  }

  if (stats.errors.length > 0) {
    p.log.warn('Some items had errors:');
    for (const err of stats.errors) {
      p.log.warn(`  - ${err.title}: ${err.error}`);
    }
  }

  p.note(savePath, 'Saved to');
  p.outro(`Done! ${summary.join(', ')}.`);
}

main().catch(() => {
  p.log.error('Unexpected error. Please try again.');
  process.exit(1);
});

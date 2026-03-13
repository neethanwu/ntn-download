import { Client, LogLevel } from '@notionhq/client';

/**
 * Thin wrapper around the Notion API with built-in rate limiting and pagination.
 */
export class NotionClient {
  constructor(token) {
    this.client = new Client({ auth: token, logLevel: LogLevel.ERROR });
    this._queue = Promise.resolve();
    this._minInterval = 340; // ~3 req/s with margin
  }

  /**
   * Serialize and throttle all API requests to stay under Notion's 3 req/s limit.
   * Uses a promise chain to ensure mutual exclusion (no concurrent requests).
   */
  _throttledCall(fn) {
    this._queue = this._queue.then(async () => {
      await new Promise((r) => setTimeout(r, this._minInterval));
      return fn();
    });
    return this._queue;
  }

  /**
   * Auto-paginate any Notion list endpoint.
   * `fn` receives { start_cursor } and must return { results, has_more, next_cursor }.
   */
  async paginate(fn, { onProgress } = {}) {
    const allResults = [];
    let cursor = undefined;

    do {
      const response = await this._throttledCall(() =>
        fn({ start_cursor: cursor })
      );
      allResults.push(...response.results);
      cursor = response.has_more ? response.next_cursor : undefined;
      if (onProgress) onProgress(allResults.length);
    } while (cursor);

    return allResults;
  }

  /**
   * Validate the token by making a test search call.
   * Returns the response on success, throws on failure.
   */
  async validateToken() {
    return this._throttledCall(() =>
      this.client.search({ page_size: 1 })
    );
  }

  /**
   * Get all top-level pages and databases shared with the integration.
   * Uses a single search call (halves API requests vs separate page/database queries).
   */
  async getTopLevelPages({ onProgress } = {}) {
    const allItems = await this.paginate(
      (opts) => this.client.search({ page_size: 100, ...opts }),
      { onProgress }
    );

    // Build a set of all item IDs so we can detect which items have
    // their parent also in the set (i.e., they're not top-level).
    const allIds = new Set(allItems.map((item) => item.id));

    // Cache for parent lookups — inline databases don't appear in search
    // results, so we fetch their metadata to check ancestry.
    const parentCache = new Map();

    const topLevel = [];

    for (const item of allItems) {
      // An item is "top-level" if its parent is the workspace, OR if its
      // parent is not among the items shared with the integration (meaning
      // it's the root of whatever subtree was shared).
      const parentId = item.parent?.page_id || item.parent?.database_id;
      const parentInResults = parentId && allIds.has(parentId);

      if (item.parent?.type === 'workspace') {
        // Workspace-level items are always top-level
      } else if (parentInResults) {
        // Parent is in search results — this item is nested, skip it
        continue;
      } else if (item.parent?.type === 'block_id' && item.parent?.block_id) {
        // Child pages inside a page are parented to a block, not the page.
        // Walk up the block's parent chain to find the owning page/database.
        try {
          let currentId = item.parent.block_id;
          let found = false;
          // Walk up to 5 levels of block nesting (toggles inside columns, etc.)
          for (let i = 0; i < 5; i++) {
            if (!parentCache.has(currentId)) {
              const block = await this._throttledCall(() =>
                this.client.blocks.retrieve({ block_id: currentId })
              );
              parentCache.set(currentId, block);
            }
            const block = parentCache.get(currentId);
            const ownerId = block?.parent?.page_id || block?.parent?.database_id;
            if (ownerId && allIds.has(ownerId)) {
              found = true;
              break;
            }
            // If the block's parent is another block, keep walking up
            if (block?.parent?.type === 'block_id' && block?.parent?.block_id) {
              currentId = block.parent.block_id;
              continue;
            }
            break;
          }
          if (found) continue;
        } catch {
          // Block not accessible — the parent page isn't shared with
          // the integration, so this item is a legitimate root.
        }
      } else if (parentId) {
        // Parent NOT in search results — could be an inline database.
        // Fetch the parent to check if *its* parent is in our results.
        try {
          if (!parentCache.has(parentId)) {
            if (item.parent?.type === 'database_id') {
              const db = await this._throttledCall(() =>
                this.client.databases.retrieve({ database_id: parentId })
              );
              parentCache.set(parentId, db);
            } else {
              const pg = await this._throttledCall(() =>
                this.client.pages.retrieve({ page_id: parentId })
              );
              parentCache.set(parentId, pg);
            }
          }
          const parentObj = parentCache.get(parentId);
          const grandparentId = parentObj?.parent?.page_id || parentObj?.parent?.database_id;
          if (grandparentId && allIds.has(grandparentId)) {
            continue;
          }
        } catch {
          // If we can't fetch the parent, treat the item as top-level
        }
      }

      if (item.object === 'page') {
        topLevel.push({
          id: item.id,
          type: 'page',
          title: extractTitle(item),
        });
      } else if (item.object === 'database') {
        topLevel.push({
          id: item.id,
          type: 'database',
          title: extractDatabaseTitle(item),
        });
      }
    }

    return topLevel;
  }

  /**
   * Get all child blocks for a given block/page ID (paginated).
   */
  async getBlockChildren(blockId) {
    return this.paginate((opts) =>
      this.client.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        ...opts,
      })
    );
  }

  /**
   * Recursively fetch all block children through the throttled wrapper.
   * Skips child_page/child_database (handled by our own recursion).
   * This prevents notion-to-md from making unthrottled API calls.
   */
  async getBlockChildrenDeep(blockId, depth = 0) {
    const blocks = await this.getBlockChildren(blockId);

    if (depth >= 15) return blocks; // Safety valve for pathological nesting

    for (const block of blocks) {
      if (block.has_children && block.type !== 'child_page' && block.type !== 'child_database') {
        block.children = await this.getBlockChildrenDeep(block.id, depth + 1);
      }
    }

    return blocks;
  }

  /**
   * Create a proxy around the raw Notion client that routes
   * blocks.children.list through our throttle. This is passed to
   * notion-to-md so its internal fetches respect rate limits.
   */
  get throttledClient() {
    if (this._throttledClient) return this._throttledClient;

    const self = this;
    this._throttledClient = new Proxy(this.client, {
      get(target, prop) {
        if (prop === 'blocks') {
          return new Proxy(target.blocks, {
            get(blocksTarget, blocksProp) {
              if (blocksProp === 'children') {
                return new Proxy(blocksTarget.children, {
                  get(childrenTarget, childrenProp) {
                    if (childrenProp === 'list') {
                      return (args) => self._throttledCall(() => childrenTarget.list(args));
                    }
                    return childrenTarget[childrenProp];
                  },
                });
              }
              return blocksTarget[blocksProp];
            },
          });
        }
        return target[prop];
      },
    });

    return this._throttledClient;
  }

  /**
   * Query all rows/pages in a database (paginated).
   */
  async queryDatabase(databaseId) {
    return this.paginate((opts) =>
      this.client.databases.query({
        database_id: databaseId,
        page_size: 100,
        ...opts,
      })
    );
  }

  /**
   * Retrieve a single page's properties.
   */
  async getPage(pageId) {
    return this._throttledCall(() =>
      this.client.pages.retrieve({ page_id: pageId })
    );
  }
}

/**
 * Extract a page's title from its properties.
 */
export function extractTitle(page) {
  if (!page.properties) return 'Untitled';

  for (const prop of Object.values(page.properties)) {
    if (prop.type === 'title' && prop.title?.length > 0) {
      return prop.title.map((t) => t.plain_text).join('');
    }
  }

  return 'Untitled';
}

/**
 * Extract a database's title.
 */
function extractDatabaseTitle(db) {
  if (db.title?.length > 0) {
    return db.title.map((t) => t.plain_text).join('');
  }
  return 'Untitled Database';
}

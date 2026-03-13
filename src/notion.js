import { Client } from '@notionhq/client';

/**
 * Thin wrapper around the Notion API with built-in rate limiting and pagination.
 */
export class NotionClient {
  constructor(token) {
    this.client = new Client({ auth: token });
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
  async paginate(fn) {
    const allResults = [];
    let cursor = undefined;

    do {
      const response = await this._throttledCall(() =>
        fn({ start_cursor: cursor })
      );
      allResults.push(...response.results);
      cursor = response.has_more ? response.next_cursor : undefined;
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
  async getTopLevelPages() {
    const allItems = await this.paginate((opts) =>
      this.client.search({
        page_size: 100,
        ...opts,
      })
    );

    const topLevel = [];

    for (const item of allItems) {
      if (item.parent?.type !== 'workspace') continue;

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

# notion-download

Download your Notion content to local Markdown files. Beautiful guided CLI, clean output, ready for AI coding agents.

## Why?

Notion's MCP server and API are token-expensive. If you use AI coding agents like Claude Code, Codex, or OpenClaw, having your Notion content as local Markdown files is dramatically cheaper and faster.

## Prerequisites

**Node.js 20 or later** — download from [nodejs.org](https://nodejs.org) (click the big green button, run the installer).

## Quick Start

```
npx notion-download
```

That's it. The tool will walk you through everything.

## Setup Your Notion Integration (2 minutes)

The CLI guides you through this, but here's the overview:

**1. Create an internal integration**

Go to: [notion.so/profile/integrations/internal/form/new-integration](https://www.notion.so/profile/integrations/internal/form/new-integration)

- **Name:** anything you want (e.g. "export-to-fs") — cannot contain the word "notion"
- **Associated workspace:** select yours
- **Icon:** skip it
- Click **Create**

**2. Set capabilities**

On the next page, under **Capabilities**:
- **Content capabilities:**
  - **Read content** — check this (the only one you need)
  - **Update content** — uncheck
  - **Insert content** — uncheck
- **Comment capabilities:**
  - **Read comments** — uncheck
  - **Insert comments** — uncheck
- **User capabilities:**
  - Select **"No user information"**

Click **Save**.

**3. Copy your token**

Copy the **Internal Integration Secret** (starts with `ntn_`).

**4. Share pages with the integration**

Open any page you want to download in Notion:
- Click the **•••** menu at the top right
- Select **Connections**
- Add your integration

> Sharing a parent page automatically shares all its children.

## What You Get

```
~/Desktop/notion-export/
├── Project Alpha/
│   ├── Project Alpha.md
│   ├── Meeting Notes/
│   │   ├── Meeting Notes.md
│   │   └── assets/
│   │       └── screenshot.png
│   └── Design Doc/
│       └── Design Doc.md
└── Personal/
    ├── Personal.md
    └── Reading List/
        └── Reading List.md
```

- Pages become `.md` files with clean Markdown
- Folder hierarchy mirrors your Notion structure
- Images and files are downloaded to `assets/` folders with working relative links
- Databases are exported with properties as YAML frontmatter

## Features

- Guided setup — walks you through creating a Notion integration
- Select specific pages — don't have to download everything
- Cross-platform — macOS, Windows, Linux
- Token persistence — saves your token for next time
- Rate limit handling — respects Notion's API limits automatically
- Progress updates — see what's being downloaded in real time

## License

MIT

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-03-13

### Added

- Guided CLI walkthrough for creating a Notion integration and sharing pages
- Download Notion pages and databases to local Markdown files
- Recursive page hierarchy preserved as folder structure
- Database rows exported with YAML frontmatter for properties
- Image and file assets downloaded to local `assets/` folders with relative links
- Child page and database links inline in correct order (block-segment interleaving)
- Database index files for navigable relative links
- OS-aware save location picker (Desktop, Documents, Downloads, OneDrive on Windows)
- Token persistence for returning users (~/.notion-to-fs/config.json)
- Rate limit handling with automatic retry and promise-chain queue
- Real-time progress reporting (status, milestones, errors)
- Page selection with refresh loop for sharing additional pages
- Cross-platform filename sanitization (Windows reserved names, invalid chars, path traversal)
- SSRF protection blocking private/internal IP ranges in asset downloads
- Fetch timeout (60s) for asset downloads
- YAML injection protection in database frontmatter
- Cycle detection and max depth limit (20) for recursive page traversal
- ANSI Shadow ASCII art banner
- MIT license

[Unreleased]: https://github.com/neethanwu/notion-download/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/neethanwu/notion-download/releases/tag/v0.1.0

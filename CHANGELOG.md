# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-03

### Added
- Initial release of `moltbrowser-mcp`
- WebMCP Hub integration — dynamically registers per-site MCP tools based on the active browser URL
- All upstream Playwright MCP browser automation tools (navigate, click, fill, screenshot, etc.)
- `npx moltbrowser-mcp` CLI entry point
- GitHub Actions CI (lint + test on Ubuntu and macOS) and automated npm publish workflow

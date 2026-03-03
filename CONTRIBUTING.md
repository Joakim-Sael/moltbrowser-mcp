# Contributing to moltbrowser-mcp

Thanks for your interest in contributing! moltbrowser-mcp is a browser automation MCP server with [WebMCP Hub](https://webmcp-hub.com) integration — dynamic, per-site tools for browser agents.

## Project structure

```
packages/
  playwright-mcp/   # Main package published to npm as "moltbrowser-mcp"
```

## Getting started

Clone the repo and install dependencies:

```bash
git clone https://github.com/Joakim-Sael/moltbrowser-mcp.git
cd moltbrowser-mcp
npm ci
```

Install Playwright browsers:

```bash
npx playwright install --with-deps chromium
```

## Running tests

```bash
# Run all playwright-mcp tests
npm run test --workspace=packages/playwright-mcp

# Chromium only (faster)
npm run ctest --workspace=packages/playwright-mcp
```

## Lint

The lint step regenerates the README from source and checks for uncommitted changes:

```bash
npm run lint --workspace=packages/playwright-mcp
```

## What to contribute

Good areas to contribute:

- **Hub integration** (`packages/playwright-mcp/src/`) — improvements to how site-specific tools are discovered and registered
- **New hub tools** — better selectors, extraction logic, or tool definitions for sites not yet on the hub
- **Test coverage** — tests for hub proxy logic, tool registration/deregistration on navigation
- **Bug fixes** — anything in the issue tracker

Please [open an issue](https://github.com/Joakim-Sael/moltbrowser-mcp/issues) before starting work on a significant change. This helps avoid duplicate effort and makes for a smoother review.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <title>

<body>        # optional
<footer>      # optional, e.g. "Fixes #42"
```

Types: `fix`, `feat`, `docs`, `test`, `chore`, `refactor`

Example:

```
feat(hub): cache site configs to reduce hub API calls

Caches configs for 60 seconds per origin to avoid hammering the hub
on rapid navigation.

Fixes #12
```

## Pull requests

- Keep PRs small and focused — one thing at a time
- All submissions require review before merge
- Make sure lint and tests pass before opening a PR

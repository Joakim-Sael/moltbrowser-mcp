#!/usr/bin/env node
/**
 * Playwright WebMCP Hub — CLI Entry Point
 *
 * Starts the proxy MCP server that wraps upstream Playwright MCP
 * with WebMCP Hub integration for dynamic, per-site tools.
 *
 * Usage:
 *   npx moltbrowser-mcp [options]
 *
 * Hub options:
 *   --hub-url=<url>        Override hub URL (default: https://webmcp-hub.com)
 *   --hub-api-key=<key>    API key for hub write operations (also HUB_API_KEY env)
 *   --no-hub               Disable hub integration (behaves as vanilla Playwright MCP)
 *
 * All standard Playwright MCP options are also supported and passed through:
 *   --browser=<name>       Browser to use (chromium, firefox, webkit, chrome, msedge)
 *   --headless             Run in headless mode
 *   --caps=<list>          Comma-separated list of capabilities
 *   --config=<path>        Path to config JSON file
 *   --port=<number>        Port for SSE transport
 *   --host=<host>          Host for SSE transport
 *   etc.
 */

const { startProxy } = require('./src/proxy-server.js');
const hubClient = require('./src/hub-client.js');

// Parse our custom args, pass the rest through to upstream
const args = process.argv.slice(2);

let noHub = false;
const upstreamArgs = [];

for (const arg of args) {
  if (arg === '--no-hub') {
    noHub = true;
  } else if (arg.startsWith('--hub-url=')) {
    process.env.HUB_URL = arg.split('=').slice(1).join('=');
  } else if (arg.startsWith('--hub-api-key=')) {
    process.env.HUB_API_KEY = arg.split('=').slice(1).join('=');
  } else {
    // Pass through to upstream Playwright MCP
    upstreamArgs.push(arg);
  }
}

(async () => {
  let keyWarning = null;

  if (!noHub) {
    if (!process.env.HUB_API_KEY) {
      keyWarning = 'No HUB_API_KEY is configured. Contribution and reading your own configs and tools will fail until you add one. Get a free API key at https://www.webmcp-hub.com and add it to your MCP config.';
      process.stderr.write(`[moltbrowser-mcp] Warning: ${keyWarning}\n`);
    } else {
      const verification = await hubClient.verifyApiKey();
      if (verification.unreachable) {
        process.stderr.write('[moltbrowser-mcp] Warning: Hub unreachable, could not verify API key. Proceeding anyway.\n');
      } else if (!verification.valid) {
        keyWarning = `Your HUB_API_KEY is invalid or expired (${verification.error}). Contribution and reading your own configs and tools will fail until you fix it. Check or regenerate your key at https://www.webmcp-hub.com.`;
        process.stderr.write(`[moltbrowser-mcp] Warning: ${keyWarning}\n`);
      } else {
        process.stderr.write(`[moltbrowser-mcp] Authenticated as ${verification.username}.\n`);
      }
    }
  }

  await startProxy({ upstreamArgs, noHub, keyWarning });
})().catch(err => {
  process.stderr.write(`[moltbrowser-mcp] Fatal error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});

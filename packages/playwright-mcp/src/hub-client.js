/**
 * HTTP client for the WebMCP Hub REST API.
 *
 * Handles config lookup (with caching), upload, update, and voting.
 * Graceful degradation: if the hub is unreachable, returns empty results
 * so the proxy can fall back to vanilla Playwright MCP behavior.
 */

const HUB_BASE = process.env.HUB_URL || 'https://www.webmcp-hub.com';

// In-memory cache: key = "domain|url", value = { configs, timestamp }
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function hubFetch(path, init) {
  const HUB_API_KEY = process.env.HUB_API_KEY || '';
  const headers = { ...(init?.headers || {}) };
  if (init?.body) {
    headers['Content-Type'] = 'application/json';
  }
  if (HUB_API_KEY) {
    headers['Authorization'] = `Bearer ${HUB_API_KEY}`;
  }
  return fetch(`${HUB_BASE}${path}`, { ...init, headers });
}

/**
 * Verify the configured API key against the hub.
 *
 * @returns {Promise<{ valid: boolean, username?: string, error?: string, unreachable?: boolean }>}
 */
async function verifyApiKey() {
  try {
    const res = await hubFetch('/api/me');
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      return { valid: false, error: body.error || 'Invalid API key' };
    }
    if (!res.ok) {
      return { valid: false, error: `Hub returned ${res.status}` };
    }
    const data = await res.json();
    return { valid: true, username: data.username };
  } catch (_err) {
    return { valid: false, error: _err.message, unreachable: true };
  }
}

/**
 * Look up configs for a domain/URL. Returns executable configs with tools.
 * Results are cached for CACHE_TTL_MS.
 *
 * @param {string} domain
 * @param {string} [url]
 * @returns {Promise<{ configs: Array<object> }>}
 */
async function lookupConfig(domain, url) {
  const cacheKey = `${domain}|${url || ''}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { configs: cached.configs };
  }

  try {
    const params = new URLSearchParams({ domain, executable: 'true' });
    if (url) params.set('url', url);

    const res = await hubFetch(`/api/configs/lookup?${params}`);
    if (!res.ok) {
      return { configs: [] };
    }

    const data = await res.json();
    const configs = data.configs || [];

    // Only cache non-empty results. Empty results may be caused by transient
    // hub issues or auth failures — caching them makes the failure sticky for
    // the full TTL (5 min), preventing recovery on the next lookup.
    if (configs.length > 0) {
      cache.set(cacheKey, { configs, timestamp: Date.now() });
    }
    return { configs };
  } catch (_err) {
    // Hub unreachable — graceful degradation
    return { configs: [] };
  }
}

/**
 * Upload a new config to the hub.
 *
 * @param {object} data - Config data
 * @returns {Promise<{ config?: object, error?: string, existingId?: string, status: number }>}
 */
async function uploadConfig(data) {
  const res = await hubFetch('/api/configs', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (res.status === 409) {
    return { error: body.error, existingId: body.existingId, status: 409 };
  }
  if (!res.ok) {
    return { error: JSON.stringify(body.error), status: res.status };
  }
  return { config: body, status: 201 };
}

/**
 * Update an existing config by ID.
 *
 * @param {string} id
 * @param {object} data
 * @returns {Promise<{ config?: object, error?: string, status: number }>}
 */
async function updateConfig(id, data) {
  const res = await hubFetch(`/api/configs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) {
    return { error: JSON.stringify(body.error), status: res.status };
  }
  return { config: body, status: 200 };
}

/**
 * Vote on a tool within a config.
 *
 * @param {string} configId
 * @param {string} toolName
 * @param {number} vote - 1 for upvote, -1 for downvote
 * @returns {Promise<{ result?: object, error?: string, status: number }>}
 */
async function voteOnTool(configId, toolName, vote) {
  const res = await hubFetch(`/api/configs/${configId}/vote`, {
    method: 'POST',
    body: JSON.stringify({ toolName, vote }),
  });
  const body = await res.json();
  if (!res.ok) {
    return { error: body.error || JSON.stringify(body), status: res.status };
  }
  return { result: body, status: 200 };
}

/**
 * Fetch a single config by ID.
 *
 * @param {string} id
 * @returns {Promise<{ config?: object, error?: string, status: number }>}
 */
async function getConfig(id) {
  const res = await hubFetch(`/api/configs/${id}`);
  const body = await res.json();
  if (!res.ok) {
    return { error: body.error || JSON.stringify(body), status: res.status };
  }
  return { config: body, status: 200 };
}

/**
 * Add a single tool to an existing config.
 *
 * @param {string} configId
 * @param {object} tool - { name, description, inputSchema, annotations?, execution? }
 * @returns {Promise<{ tool?: object, error?: string, status: number }>}
 */
async function addTool(configId, tool) {
  const res = await hubFetch(`/api/configs/${configId}/tools`, {
    method: 'POST',
    body: JSON.stringify(tool),
  });
  const body = await res.json();
  if (res.status === 409) {
    return { error: body.error, status: 409 };
  }
  if (!res.ok) {
    return { error: JSON.stringify(body.error), status: res.status };
  }
  return { tool: body, status: 201 };
}

/**
 * Update a specific tool within a config in-place.
 *
 * @param {string} configId
 * @param {string} toolName
 * @param {object} updates - Partial tool fields (description, inputSchema, annotations, execution)
 * @returns {Promise<{ tool?: object, error?: string, status: number }>}
 */
async function updateTool(configId, toolName, updates) {
  const res = await hubFetch(`/api/configs/${configId}/tools/${encodeURIComponent(toolName)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  const body = await res.json();
  if (!res.ok) {
    return { error: body.error || JSON.stringify(body), status: res.status };
  }
  return { tool: body, status: 200 };
}

/**
 * Delete a specific tool from a config by name.
 *
 * @param {string} configId
 * @param {string} toolName
 * @returns {Promise<{ config?: object, error?: string, status: number }>}
 */
async function deleteTool(configId, toolName) {
  const res = await hubFetch(`/api/configs/${configId}/tools/${encodeURIComponent(toolName)}`, {
    method: 'DELETE',
  });
  const body = await res.json();
  if (!res.ok) {
    return { error: body.error || JSON.stringify(body), status: res.status };
  }
  return { config: body, status: 200 };
}

/** Clear the lookup cache (useful for testing). */
function clearCache() {
  cache.clear();
}

module.exports = {
  lookupConfig,
  uploadConfig,
  updateConfig,
  addTool,
  updateTool,
  getConfig,
  voteOnTool,
  deleteTool,
  clearCache,
  verifyApiKey,
};

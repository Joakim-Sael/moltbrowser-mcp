/**
 * Hub Tools
 *
 * Defines MCP tool schemas and handlers for:
 * - hub_execute: Single static tool for running hub-sourced tools (solves Cursor/frozen-schema issue)
 * - contribute_create-config: Create an empty config shell (returns ID)
 * - contribute_add-tool: Add a single tool to a config with flat execution fields
 * - contribute_vote-on-tool: Upvote or downvote a tool in a config
 *
 * hub_execute and contribute_* tools are always-available (not dynamic per-page tools).
 */

const hub = require('./hub-client.js');
const { translate } = require('./execution-translator.js');

// --- hub_execute: static tool for running hub-sourced tools ---

/**
 * Get the MCP tool definition for hub_execute.
 * This is always present in tools/list (when hub is enabled).
 */
function getHubExecuteToolDefinition() {
  return {
    name: 'hub_execute',
    description: 'Execute a pre-configured hub tool for the current site. After navigating, the response will list available tool names and their arguments. Use this tool to run them.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: {
          type: 'string',
          description: 'The hub tool name to run (e.g. "get-rows", "search-products"). Shown in the navigation response.',
        },
        arguments: {
          type: 'object',
          description: 'Arguments to pass to the hub tool. See the navigation response for required/optional arguments per tool.',
          additionalProperties: true,
        },
      },
      required: ['toolName'],
    },
  };
}

/**
 * Handle a hub_execute call.
 * Looks up the tool in hubToolMap, translates execution metadata to Playwright code,
 * and runs it via browser_run_code on the upstream.
 *
 * @param {object} args - { toolName: string, arguments?: object }
 * @param {Map} hubToolMap - The dynamic tool registry
 * @param {Client} upstreamClient - The upstream Playwright MCP client
 * @returns {Promise<object>} MCP tool response
 */
async function handleHubExecute(args, hubToolMap, upstreamClient) {
  const { toolName, arguments: toolArgs = {} } = args;

  if (!toolName) {
    return {
      content: [{ type: 'text', text: 'Error: toolName is required. Specify which hub tool to run.' }],
      isError: true,
    };
  }

  // Tolerate both "get-rows" and "hub_get-rows"
  const lookupName = toolName.startsWith('hub_') ? toolName : `hub_${toolName}`;
  const hubEntry = hubToolMap.get(lookupName);

  if (!hubEntry) {
    if (hubToolMap.size === 0) {
      return {
        content: [{ type: 'text', text: `No hub tools available. Navigate to a page first with browser_navigate — hub tools are discovered automatically after navigation.` }],
        isError: true,
      };
    }

    const available = Array.from(hubToolMap.keys()).map(k => k.replace(/^hub_/, '')).join(', ');
    return {
      content: [{ type: 'text', text: `Hub tool "${toolName}" not found. Available tools: ${available}` }],
      isError: true,
    };
  }

  return await executeHubTool(upstreamClient, hubEntry, toolArgs);
}

/**
 * Execute a hub-sourced tool by translating its execution metadata
 * to Playwright code and running it via browser_run_code on the upstream.
 *
 * @param {Client} upstreamClient
 * @param {{ tool: object, execution: object, configId: string }} hubEntry
 * @param {object} args - The arguments the agent provided
 * @returns {Promise<object>} MCP tool response
 */
async function executeHubTool(upstreamClient, hubEntry, args) {
  // Translate once, reuse if needed
  const code = translate(hubEntry.execution, args);

  if (!code || code.trim() === '') {
    return {
      content: [{ type: 'text', text: 'No actions to execute for this tool (empty execution metadata).' }],
    };
  }

  try {
    const result = await upstreamClient.callTool({
      name: 'browser_run_code',
      arguments: { code },
    });

    if (result.isError) {
      const errorText = result.content?.map(c => c.text || '').join('\n') || 'Unknown error';
      return {
        content: [{
          type: 'text',
          text: `Hub tool "${hubEntry.tool.name}" failed:\n${errorText}\n\nUse browser_fallback to access generic Playwright tools.`,
        }],
        isError: true,
      };
    }

    return result;
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: `Hub tool "${hubEntry.tool.name}" failed: ${err.message}\n\nUse browser_fallback to access generic Playwright tools.`,
      }],
      isError: true,
    };
  }
}

// --- contribute_* tools: hub write operations ---

/**
 * Tool definitions for hub write operations.
 * Each entry has: name, description, inputSchema, handler.
 */
const hubWriteTools = [
  {
    name: 'contribute_create-config',
    description: [
      'Create a new WebMCP config shell on the hub. Returns a config ID.',
      'After creating, use contribute_add-tool to add tools with CSS selectors.',
      '',
      'Example:',
      'contribute_create-config({ domain: "example.com", urlPattern: "example.com/products", title: "Example Store", description: "Search and browse products" })',
      '→ "Config created! ID: abc123. Use contribute_add-tool to add tools."',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: "Bare domain without protocol. Example: 'github.com', NOT 'https://github.com'" },
        urlPattern: { type: 'string', description: "URL scope in 'domain/path' format. Use the current page path from browser_navigate. Patterns: 'example.com' (all pages — only for site-wide tools like nav/search), 'example.com/dashboard' (exact page), 'example.com/users/:id' (dynamic segment — matches /users/alice, /users/123), 'example.com/admin/**' (wildcard — matches /admin and everything under it). IMPORTANT: scope to the specific page or section, not the bare domain. SPA OVERLAY WARNING: On SPAs, clicking a button (e.g. Reply) may change the URL to an overlay path (e.g. /compose/post). The extension re-discovers tools on every URL change, so the new URL's config completely replaces the previous one. If a tool action causes a URL change, the destination URL's config MUST include ALL tools needed to complete the workflow (e.g. fill-text + submit), not just the triggering action." },
        title: { type: 'string', description: 'Name the page or section, not the task you performed. GOOD: "X Home Feed", "GitHub Repo Page", "Reddit Community Feed", "YouTube Watch Page". BAD: "X Home - Post Composer", "GitHub Create Issue", "Reddit Submit Post". Keep it short and page-centric.' },
        description: { type: 'string', description: 'Describe the site or page in general terms — what it IS, not what you are currently doing on it. Think of it as a caption for the page type. GOOD: "YouTube - a platform for sharing and discovering video content", "GitHub Issues - track and manage project issues and bug reports", "Reddit feed - a community platform for posts, discussions, and voting". BAD: "Search for videos on youtube.com", "Like a post", "Open the compose dialog". Avoid task-specific or session-specific phrases.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for categorization',
        },
      },
      required: ['domain', 'urlPattern', 'title', 'description'],
    },
  },
  {
    name: 'contribute_add-tool',
    description: [
      'Add a single tool to an existing config. Provide flat execution fields — inputSchema and execution objects are built automatically.',
      '',
      'IMPORTANT: Always create read-only extraction tools first (get-posts, get-content, list-items).',
      'These are the most useful tools for other agents. Then add action tools (search, click, fill) if relevant.',
      '',
      'Prefer small, single-action tools over multi-step workflows. For complex interactions (e.g. posting a tweet),',
      'create one tool per action (click-compose, fill-tweet-text, click-post-button) — the calling agent will chain them.',
      '',
      'EXAMPLE — read-only list extraction (most common, start here):',
      'contribute_add-tool({',
      '  configId: "abc123",',
      '  name: "get-posts",',
      '  description: "Get all visible posts on the page",',
      '  selector: ".feed",',
      '  resultSelector: ".feed .post",',
      '  resultExtract: "list"',
      '})',
      '',
      'EXAMPLE — read-only page content:',
      'contribute_add-tool({',
      '  configId: "abc123",',
      '  name: "get-article",',
      '  description: "Get the main article text",',
      '  selector: "article",',
      '  resultSelector: "article",',
      '  resultExtract: "text"',
      '})',
      '',
      'EXAMPLE — single click action (e.g. open compose dialog):',
      'contribute_add-tool({',
      '  configId: "abc123",',
      '  name: "click-compose-button",',
      '  description: "Click the compose/new tweet button to open the tweet editor",',
      '  steps: [{ action: "click", selector: "[data-testid=SideNav_NewTweet_Button]" }]',
      '})',
      '',
      'EXAMPLE — single fill action (e.g. type into a text field):',
      'contribute_add-tool({',
      '  configId: "abc123",',
      '  name: "fill-tweet-text",',
      '  description: "Fill the tweet text area with content",',
      '  selector: "[data-testid=tweetTextarea_0]",',
      '  fields: [{ type: "textarea", selector: "[data-testid=tweetTextarea_0]", name: "text", description: "The tweet text to type" }]',
      '})',
      '',
      'EXAMPLE — single click to submit:',
      'contribute_add-tool({',
      '  configId: "abc123",',
      '  name: "click-post-button",',
      '  description: "Click the Post button to submit the tweet",',
      '  steps: [{ action: "click", selector: "[data-testid=tweetButtonInline]" }]',
      '})',
      '',
      'EXAMPLE — search form (fill + submit is still atomic enough):',
      'contribute_add-tool({',
      '  configId: "abc123",',
      '  name: "search-products",',
      '  description: "Search products by keyword",',
      '  selector: "#searchForm",',
      '  autosubmit: true,',
      '  submitSelector: "#searchBtn",',
      '  submitAction: "click",',
      '  fields: [{ type: "text", selector: "#searchInput", name: "query", description: "Search term" }],',
      '  resultSelector: ".results li",',
      '  resultExtract: "list"',
      '})',
      '',
      'KEY RULES:',
      '- Tools must be GENERAL, not hardcoded to a specific instance or position. WRONG: "like-first-post" (hardcoded to first). RIGHT: "like-post" with a parameter that identifies which post (e.g. postIndex: number, or postText: string used in a :has-text selector). If your tool name describes a specific case or position rather than a reusable action, redesign it with a parameter.',
      '- Prefer small, single-action tools over multi-step workflows',
      '- For multi-step interactions, create one tool per action (click-compose, fill-text, click-submit) — the calling agent will chain them',
      '- Click tools use steps: [{ action: "click", selector: "..." }] — do NOT use autosubmit: true for standalone buttons',
      '- Fill tools need: selector + one field entry',
      '- Tool names must be kebab-case with a verb: "get-posts", "click-compose-button", "fill-tweet-text", "search-products"',
      '- Read-only tools only need: selector, resultSelector, resultExtract. No autosubmit, no fields.',
      '- Use fields[] for form inputs — each field\'s name becomes a tool parameter automatically',
      '- resultExtract options: text, html, attribute, list, table',
      '- Advanced: steps[] and inputProperties are available for complex cases, but prefer atomic tools instead',
      '- Use evaluate steps sparingly: { action: "evaluate", value: "document.querySelector(\'...\').click()" } runs raw JS — useful for force-clicking elements blocked by overlays',
      '- If you use a condition step, verify the selector in EACH branch with browser_snapshot — never assume',
      '  two contexts (e.g. a dialog vs. an inline composer) share the same test IDs or element structure',
      '- SPA OVERLAY TRAP: If a tool click changes the URL (e.g. reply button → /compose/post), the extension',
      '  re-discovers tools at the NEW URL. That new config replaces all previous tools. You MUST:',
      '  1. Create a config for the destination URL',
      '  2. Include ALL tools needed there (fill + submit, not just submit)',
      '  3. Verify every selector with browser_snapshot at the destination URL — never copy selectors',
      '     from a different URL\'s config (e.g. tweetButtonInline on /home ≠ tweetButton in reply dialog)',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        configId: { type: 'string', description: 'The config ID from contribute_create-config' },
        name: { type: 'string', description: 'Kebab-case tool name with verb: "search-products", "get-rows"' },
        description: { type: 'string', description: 'What the tool does' },

        // Flat execution fields:
        selector: { type: 'string', description: 'Container CSS selector' },
        autosubmit: { type: 'boolean', description: 'Whether to click a submit button after filling fields. Only for form tools with fields[]. For standalone button clicks, use steps: [{action: "click", selector: "..."}] instead.' },
        submitSelector: { type: 'string', description: 'CSS selector for the submit button (only used with autosubmit + fields[])' },
        submitAction: { type: 'string', description: 'How to submit: "click" or "enter" (only used with autosubmit + fields[])' },
        resultSelector: { type: 'string', description: 'CSS selector for the result area' },
        resultExtract: { type: 'string', description: 'How to extract results: text, html, attribute, list, table' },
        resultAttribute: { type: 'string', description: 'HTML attribute to read when resultExtract is "attribute" (e.g. "href", "data-id")' },
        resultRequired: { type: 'boolean', description: 'If true, the tool throws an error when no results are found instead of silently returning empty' },
        resultWaitSelector: { type: 'string', description: 'CSS selector to wait for before extracting results' },
        resultDelay: { type: 'number', description: 'Milliseconds to wait before extracting results' },

        // Input fields (for form-based tools):
        fields: {
          type: 'array',
          description: 'Form input fields. Each field becomes a tool parameter automatically.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Field type: text, number, textarea, select, checkbox, radio, date, file, hidden' },
              selector: { type: 'string', description: 'CSS selector for the field' },
              name: { type: 'string', description: 'Parameter name (used in inputSchema)' },
              description: { type: 'string', description: 'What this field is for' },
              required: { type: 'boolean', description: 'Whether the field is required (default: true)' },
              defaultValue: { description: 'Default value pre-filled into the field' },
              options: {
                type: 'array',
                description: 'Explicit options for select/radio fields',
                items: {
                  type: 'object',
                  properties: {
                    value: { type: 'string' },
                    label: { type: 'string' },
                    selector: { type: 'string', description: 'Optional per-option CSS selector' },
                  },
                  required: ['value', 'label'],
                },
              },
              dynamicOptions: { type: 'boolean', description: 'True for select fields whose options are populated at runtime' },
            },
            required: ['type', 'selector', 'name', 'description'],
          },
        },

        // Multi-step tools:
        steps: {
          type: 'array',
          description: 'Steps for multi-step tools. Use {{paramName}} for parameter interpolation.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'Action: click, fill, select, wait, extract, navigate, scroll, condition, evaluate' },
              selector: { type: 'string', description: 'CSS selector for the action target (required for: click, fill, select, wait, extract, scroll, condition)' },
              value: { type: 'string', description: 'Value for fill/select/evaluate actions. Use {{paramName}} for params.' },
              url: { type: 'string', description: 'URL for navigate action' },
              state: { type: 'string', description: 'State to check for condition action (e.g. "visible", "hidden")' },
            },
            required: ['action'],
          },
        },

        // Explicit input parameters (for steps-based tools):
        inputProperties: {
          type: 'object',
          description: 'Tool input parameters. Format: { paramName: "type|description" } or { paramName: "description" }. Used when steps[] reference {{paramName}} templates.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['configId', 'name', 'description'],
    },
  },
  {
    name: 'contribute_update-tool',
    description: [
      'Update an existing tool in a config. Finds the tool by name and replaces it with the new fields you provide.',
      'Use this to fix broken selectors, update execution metadata, or change a tool\'s description.',
      'Same flat fields as contribute_add-tool — inputSchema and execution are rebuilt automatically.',
      '',
      'EXAMPLE — fix a broken click-post-button tool with an updated selector:',
      'contribute_update-tool({',
      '  configId: "abc123",',
      '  name: "click-post-button",',
      '  description: "Click the Post button to submit the tweet",',
      '  steps: [{ action: "click", selector: "[data-testid=tweetButtonInline]" }]',
      '})',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        configId: { type: 'string', description: 'The config ID containing the tool to update' },
        name: { type: 'string', description: 'The name of the existing tool to update (must already exist in the config)' },
        description: { type: 'string', description: 'Updated description of what the tool does' },

        // Flat execution fields (same as contribute_add-tool):
        selector: { type: 'string', description: 'Container CSS selector' },
        autosubmit: { type: 'boolean', description: 'Whether to click a submit button after filling fields. Omit for read-only extraction tools.' },
        submitSelector: { type: 'string', description: 'CSS selector for the submit button' },
        submitAction: { type: 'string', description: 'How to submit: "click" or "enter"' },
        resultSelector: { type: 'string', description: 'CSS selector for the result area' },
        resultExtract: { type: 'string', description: 'How to extract results: text, html, attribute, list, table' },
        resultAttribute: { type: 'string', description: 'HTML attribute to read when resultExtract is "attribute" (e.g. "href", "data-id")' },
        resultRequired: { type: 'boolean', description: 'If true, the tool throws an error when no results are found instead of silently returning empty' },
        resultWaitSelector: { type: 'string', description: 'CSS selector to wait for before extracting results' },
        resultDelay: { type: 'number', description: 'Milliseconds to wait before extracting results' },
        fields: {
          type: 'array',
          description: 'Form input fields. Each field becomes a tool parameter automatically.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Field type: text, number, textarea, select, checkbox, radio, date, file, hidden' },
              selector: { type: 'string', description: 'CSS selector for the field' },
              name: { type: 'string', description: 'Parameter name (used in inputSchema)' },
              description: { type: 'string', description: 'What this field is for' },
              required: { type: 'boolean', description: 'Whether the field is required (default: true)' },
              defaultValue: { description: 'Default value pre-filled into the field' },
              options: {
                type: 'array',
                description: 'Explicit options for select/radio fields',
                items: {
                  type: 'object',
                  properties: {
                    value: { type: 'string' },
                    label: { type: 'string' },
                    selector: { type: 'string', description: 'Optional per-option CSS selector' },
                  },
                  required: ['value', 'label'],
                },
              },
              dynamicOptions: { type: 'boolean', description: 'True for select fields whose options are populated at runtime' },
            },
            required: ['type', 'selector', 'name', 'description'],
          },
        },
        steps: {
          type: 'array',
          description: 'Steps for multi-step tools. Use {{paramName}} for parameter interpolation.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'Action: click, fill, select, wait, extract, navigate, scroll, condition, evaluate' },
              selector: { type: 'string', description: 'CSS selector for the action target (required for: click, fill, select, wait, extract, scroll, condition)' },
              value: { type: 'string', description: 'Value for fill/select/evaluate actions. Use {{paramName}} for params.' },
              url: { type: 'string', description: 'URL for navigate action' },
              state: { type: 'string', description: 'State to check for condition action (e.g. "visible", "hidden")' },
            },
            required: ['action'],
          },
        },
        inputProperties: {
          type: 'object',
          description: 'Tool input parameters. Format: { paramName: "type|description" } or { paramName: "description" }.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['configId', 'name'],
    },
  },
  {
    name: 'contribute_delete-tool',
    description: 'Delete a specific tool from a WebMCP Hub config. The config owner or the tool\'s own contributor can delete tools. Use this to remove a tool that is broken, incorrect, or no longer needed.',
    inputSchema: {
      type: 'object',
      properties: {
        configId: { type: 'string', description: 'The config ID containing the tool to delete' },
        toolName: { type: 'string', description: "The name of the tool to delete, e.g. 'search-products'" },
      },
      required: ['configId', 'toolName'],
    },
  },
  {
    name: 'contribute_vote-on-tool',
    description: 'Upvote or downvote a tool within a WebMCP Hub config. Each user gets one vote per tool — voting the same direction again removes the vote. Use this to signal quality: upvote tools that work, downvote broken ones.',
    inputSchema: {
      type: 'object',
      properties: {
        configId: { type: 'string', description: 'The config ID (from navigation tool list or hub lookup)' },
        toolName: { type: 'string', description: "The tool name to vote on, e.g. 'search-repos'" },
        vote: { type: 'number', description: '1 for upvote, -1 for downvote' },
      },
      required: ['configId', 'toolName', 'vote'],
    },
  },
];

// --- Local validation ---

const VALID_RESULT_EXTRACTS = new Set(['text', 'html', 'attribute', 'list', 'table']);
const VALID_STEP_ACTIONS = new Set(['navigate', 'click', 'fill', 'select', 'wait', 'extract', 'scroll', 'condition', 'evaluate']);

/**
 * Validate that each step has the fields required for its action type.
 * Returns an array of human-readable error strings with exact paths.
 *
 * @param {Array} steps
 * @param {string} [prefix] - e.g. "steps" or "execution.steps"
 * @returns {string[]}
 */
function validateStepFields(steps, prefix = 'steps') {
  const errors = [];
  for (let j = 0; j < steps.length; j++) {
    const s = steps[j];
    const p = `${prefix}[${j}]`;
    if (['click', 'fill', 'select', 'wait', 'extract', 'scroll'].includes(s.action) && !s.selector) {
      errors.push(`${p}.action "${s.action}" requires a "selector" field`);
    }
    if (['fill', 'select', 'evaluate'].includes(s.action) && !s.value) {
      errors.push(`${p}.action "${s.action}" requires a "value" field`);
    }
    if (s.action === 'navigate' && !s.url) {
      errors.push(`${p}.action "navigate" requires a "url" field`);
    }
    if (s.action === 'condition' && !s.selector) {
      errors.push(`${p}.action "condition" requires a "selector" field`);
    }
    if (s.action === 'condition' && !s.state) {
      errors.push(`${p}.action "condition" requires a "state" field`);
    }
  }
  return errors;
}

/**
 * Validate a config's tools array before sending to the hub.
 * Returns an array of human-readable error strings with exact paths.
 * Returns empty array if valid.
 */
function validateTools(tools) {
  const errors = [];

  if (!Array.isArray(tools)) {
    errors.push('tools: must be an array');
    return errors;
  }

  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    const p = `tools[${i}]`;

    if (!t || typeof t !== 'object') {
      errors.push(`${p}: must be an object, got ${typeof t}`);
      continue;
    }

    // name — only hard requirement we still block on
    if (!t.name || typeof t.name !== 'string') {
      errors.push(`${p}.name: required, must be a string`);
    } else if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(t.name)) {
      errors.push(`${p}.name: "${t.name}" is not kebab-case with a verb. Use format like "search-products", "get-rows", "add-item"`);
    }

    // description
    if (!t.description || typeof t.description !== 'string') {
      errors.push(`${p}.description: required, must be a string`);
    }

    // If execution is present and is an object, validate its internals.
    if (t.execution && typeof t.execution === 'object') {
      const ex = t.execution;
      const ep = `${p}.execution`;

      if (ex.resultExtract && !VALID_RESULT_EXTRACTS.has(ex.resultExtract)) {
        errors.push(`${ep}.resultExtract: "${ex.resultExtract}" is invalid. Must be one of: ${[...VALID_RESULT_EXTRACTS].join(', ')}`);
      }

      if (ex.steps && Array.isArray(ex.steps)) {
        for (let j = 0; j < ex.steps.length; j++) {
          const s = ex.steps[j];
          if (s.action && !VALID_STEP_ACTIONS.has(s.action)) {
            errors.push(`${ep}.steps[${j}].action: "${s.action}" is invalid. Must be one of: ${[...VALID_STEP_ACTIONS].join(', ')}`);
          }
        }
        errors.push(...validateStepFields(ex.steps, `${ep}.steps`));
      }
    }
  }

  return errors;
}

/**
 * Validate top-level config fields. Returns error strings with exact paths.
 */
function validateConfig(args) {
  const errors = [];

  if (args.domain && /^https?:\/\//.test(args.domain)) {
    errors.push(`domain: "${args.domain}" includes a protocol. Use bare domain like "github.com", not "https://github.com"`);
  }

  if (args.urlPattern && /^https?:\/\//.test(args.urlPattern)) {
    errors.push(`urlPattern: "${args.urlPattern}" includes a protocol. Use "domain/path" format like "github.com/search"`);
  }

  if (args.tools) {
    errors.push(...validateTools(args.tools));
  }

  return errors;
}

/**
 * Build an inputSchema object from flat fields.
 * - If fields[] is provided, each field's name becomes a property (type defaults to "string").
 * - If inputProperties is provided, parse "type|description" or just "description" format.
 * - If neither is provided, returns an empty schema.
 */
function buildInputSchema(args) {
  const properties = {};
  const required = [];

  // From fields[] — each field becomes a parameter
  if (Array.isArray(args.fields)) {
    for (const field of args.fields) {
      if (!field.name) continue;
      properties[field.name] = {
        type: field.type === 'number' ? 'number' : field.type === 'checkbox' ? 'boolean' : 'string',
        description: field.description || field.name,
      };
      if (field.required !== false) {
        required.push(field.name);
      }
    }
  }

  // From inputProperties — explicit parameter definitions
  if (args.inputProperties && typeof args.inputProperties === 'object') {
    for (const [paramName, spec] of Object.entries(args.inputProperties)) {
      if (typeof spec !== 'string') continue;
      const parts = spec.split('|');
      if (parts.length >= 2) {
        properties[paramName] = { type: parts[0], description: parts.slice(1).join('|') };
      } else {
        properties[paramName] = { type: 'string', description: parts[0] };
      }
      if (!required.includes(paramName)) {
        required.push(paramName);
      }
    }
  }

  const schema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Build an execution object from flat args.
 * Returns null if no execution-relevant fields are provided.
 */
function buildExecution(args) {
  const hasExecFields = args.selector || args.resultSelector || args.submitSelector ||
    args.fields || args.steps;

  if (!hasExecFields) return null;

  const execution = {
    selector: args.selector || 'body',
    autosubmit: args.autosubmit ?? false,
  };

  if (args.submitSelector) execution.submitSelector = args.submitSelector;
  if (args.submitAction) execution.submitAction = args.submitAction;
  if (args.resultSelector) execution.resultSelector = args.resultSelector;
  if (args.resultExtract) execution.resultExtract = args.resultExtract;
  if (args.resultAttribute) execution.resultAttribute = args.resultAttribute;
  if (args.resultRequired !== undefined) execution.resultRequired = args.resultRequired;
  if (args.resultWaitSelector) execution.resultWaitSelector = args.resultWaitSelector;
  if (args.resultDelay) execution.resultDelay = args.resultDelay;
  if (Array.isArray(args.fields)) execution.fields = args.fields;
  if (Array.isArray(args.steps)) execution.steps = args.steps;

  return execution;
}

/**
 * Handle a hub write tool call.
 *
 * @param {string} toolName
 * @param {object} args
 * @returns {Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }>}
 */
async function handleHubWriteTool(toolName, args) {
  try {
    if (toolName === 'contribute_create-config') {
      // Validate flat fields
      const validationErrors = validateConfig(args);
      if (validationErrors.length > 0) {
        return {
          content: [{ type: 'text', text: `Config validation failed:\n\n${validationErrors.map(e => `- ${e}`).join('\n')}` }],
          isError: true,
        };
      }

      // Explicitly ignore any tools the agent passes — tools are added via contribute_add-tool
      const result = await hub.uploadConfig({
        domain: args.domain,
        urlPattern: args.urlPattern,
        title: args.title,
        description: args.description,
        tools: [],
        tags: args.tags,
      });

      if (result.status === 409) {
        return {
          content: [{ type: 'text', text: `A config already exists for this domain+urlPattern. Existing config ID: ${result.existingId}. You can add tools to it directly with contribute_add-tool using that ID.` }],
          isError: true,
        };
      }

      if (result.error) {
        return {
          content: [{ type: 'text', text: `Error creating config: ${result.error}` }],
          isError: true,
        };
      }

      const configId = result.config?.id || 'unknown';
      return {
        content: [{ type: 'text', text: `Config created! ID: ${configId}. Now use contribute_add-tool to add tools with CSS selectors.` }],
      };
    }

    if (toolName === 'contribute_add-tool') {
      const { configId, name, description } = args;

      if (!configId) {
        return {
          content: [{ type: 'text', text: 'Error: configId is required. Create a config first with contribute_create-config.' }],
          isError: true,
        };
      }
      if (!name || typeof name !== 'string') {
        return {
          content: [{ type: 'text', text: 'Error: name is required (kebab-case with verb, e.g. "search-products").' }],
          isError: true,
        };
      }
      if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) {
        return {
          content: [{ type: 'text', text: `Error: name "${name}" is not kebab-case with a verb. Use format like "search-products", "get-rows", "add-item".` }],
          isError: true,
        };
      }
      if (!description || typeof description !== 'string') {
        return {
          content: [{ type: 'text', text: 'Error: description is required.' }],
          isError: true,
        };
      }

      // Build inputSchema and execution from flat fields
      const inputSchema = buildInputSchema(args);
      const execution = buildExecution(args);

      // Validate execution internals if present
      if (execution) {
        if (execution.resultExtract && !VALID_RESULT_EXTRACTS.has(execution.resultExtract)) {
          return {
            content: [{ type: 'text', text: `Error: resultExtract "${execution.resultExtract}" is invalid. Must be one of: ${[...VALID_RESULT_EXTRACTS].join(', ')}` }],
            isError: true,
          };
        }
        if (execution.steps && Array.isArray(execution.steps)) {
          for (let j = 0; j < execution.steps.length; j++) {
            const s = execution.steps[j];
            if (s.action && !VALID_STEP_ACTIONS.has(s.action)) {
              return {
                content: [{ type: 'text', text: `Error: steps[${j}].action "${s.action}" is invalid. Must be one of: ${[...VALID_STEP_ACTIONS].join(', ')}` }],
                isError: true,
              };
            }
          }
          const stepErrors = validateStepFields(execution.steps);
          if (stepErrors.length > 0) {
            return {
              content: [{ type: 'text', text: `Error: invalid step fields:\n\n${stepErrors.map(e => `- ${e}`).join('\n')}` }],
              isError: true,
            };
          }
        }
      }

      // Build the tool object
      const newTool = { name, description, inputSchema };
      if (execution) newTool.execution = execution;

      // POST the single tool directly — no need to fetch the full config first
      const result = await hub.addTool(configId, newTool);
      if (result.status === 409) {
        return {
          content: [{ type: 'text', text: `A tool named "${name}" already exists in config ${configId}. Use contribute_update-tool to update it, or choose a different name.` }],
          isError: true,
        };
      }
      if (result.error) {
        return {
          content: [{ type: 'text', text: `Error adding tool to config: ${result.error}` }],
          isError: true,
        };
      }

      const warnings = [];
      if (!execution) {
        warnings.push('Warning: No execution fields provided — this tool won\'t be executable by other agents. Consider adding selector, resultSelector, fields, or steps.');
      }

      hub.clearCache();
      const msg = `Tool "${name}" added to config ${configId}!${warnings.length > 0 ? '\n\n' + warnings.join('\n') : ''}`;
      return {
        content: [{ type: 'text', text: msg }],
      };
    }

    if (toolName === 'contribute_update-tool') {
      const { configId, name } = args;

      if (!configId) {
        return {
          content: [{ type: 'text', text: 'Error: configId is required.' }],
          isError: true,
        };
      }
      if (!name || typeof name !== 'string') {
        return {
          content: [{ type: 'text', text: 'Error: name is required (the name of the existing tool to update).' }],
          isError: true,
        };
      }

      // Fetch existing config
      const existing = await hub.getConfig(configId);
      if (existing.error) {
        return {
          content: [{ type: 'text', text: `Error fetching config ${configId}: ${existing.error}` }],
          isError: true,
        };
      }

      const existingTools = existing.config?.tools || [];
      const toolIndex = existingTools.findIndex(t => t.name === name);
      if (toolIndex === -1) {
        const available = existingTools.map(t => `"${t.name}"`).join(', ');
        return {
          content: [{ type: 'text', text: `Error: tool "${name}" not found in config ${configId}. Available tools: ${available || '(none)'}` }],
          isError: true,
        };
      }

      // Build new inputSchema and execution from flat fields
      const inputSchema = buildInputSchema(args);
      const execution = buildExecution(args);

      // Validate execution internals if present
      if (execution) {
        if (execution.resultExtract && !VALID_RESULT_EXTRACTS.has(execution.resultExtract)) {
          return {
            content: [{ type: 'text', text: `Error: resultExtract "${execution.resultExtract}" is invalid. Must be one of: ${[...VALID_RESULT_EXTRACTS].join(', ')}` }],
            isError: true,
          };
        }
        if (execution.steps && Array.isArray(execution.steps)) {
          for (let j = 0; j < execution.steps.length; j++) {
            const s = execution.steps[j];
            if (s.action && !VALID_STEP_ACTIONS.has(s.action)) {
              return {
                content: [{ type: 'text', text: `Error: steps[${j}].action "${s.action}" is invalid. Must be one of: ${[...VALID_STEP_ACTIONS].join(', ')}` }],
                isError: true,
              };
            }
          }
          const stepErrors = validateStepFields(execution.steps);
          if (stepErrors.length > 0) {
            return {
              content: [{ type: 'text', text: `Error: invalid step fields:\n\n${stepErrors.map(e => `- ${e}`).join('\n')}` }],
              isError: true,
            };
          }
        }
      }

      // Build the replacement tool — keep existing description/inputSchema/execution if not provided
      const existingTool = existingTools[toolIndex];
      const updatedTool = {
        name,
        description: args.description || existingTool.description,
        inputSchema: Object.keys(inputSchema.properties || {}).length > 0 ? inputSchema : existingTool.inputSchema,
      };
      if (execution) {
        updatedTool.execution = execution;
      } else if (existingTool.execution) {
        updatedTool.execution = existingTool.execution;
      }

      // Update the tool in-place via PATCH (atomic — no delete-then-add risk)
      const { name: _toolName, ...toolUpdates } = updatedTool;
      const updateResult = await hub.updateTool(configId, name, toolUpdates);
      if (updateResult.error) {
        return {
          content: [{ type: 'text', text: `Error updating tool: ${updateResult.error}` }],
          isError: true,
        };
      }

      hub.clearCache();
      return {
        content: [{ type: 'text', text: `Tool "${name}" updated in config ${configId}!` }],
      };
    }

    if (toolName === 'contribute_delete-tool') {
      const { configId, toolName: name } = args;

      if (!configId) {
        return {
          content: [{ type: 'text', text: 'Error: configId is required.' }],
          isError: true,
        };
      }
      if (!name) {
        return {
          content: [{ type: 'text', text: 'Error: toolName is required.' }],
          isError: true,
        };
      }

      const result = await hub.deleteTool(configId, name);

      if (result.error) {
        return {
          content: [{ type: 'text', text: `Error deleting tool: ${result.error}` }],
          isError: true,
        };
      }

      hub.clearCache();
      return {
        content: [{ type: 'text', text: `Tool "${name}" deleted from config ${configId}. Config now has ${result.config?.tools?.length ?? 0} tool(s).` }],
      };
    }

    if (toolName === 'contribute_vote-on-tool') {
      if (args.vote !== 1 && args.vote !== -1) {
        return {
          content: [{ type: 'text', text: 'Error: vote must be 1 or -1' }],
          isError: true,
        };
      }

      const result = await hub.voteOnTool(args.configId, args.toolName, args.vote);

      if (result.error) {
        return {
          content: [{ type: 'text', text: `Error voting: ${result.error}` }],
          isError: true,
        };
      }

      const r = result.result;
      const label = r.userVote === 1 ? 'upvoted' : r.userVote === -1 ? 'downvoted' : 'removed vote';
      return {
        content: [{ type: 'text', text: `Vote recorded: ${label} tool "${r.toolName}" in config ${r.configId}. Current score: ${r.score}` }],
      };
    }

    return {
      content: [{ type: 'text', text: `Unknown hub tool: ${toolName}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Hub unreachable: ${err.message}` }],
      isError: true,
    };
  }
}

/**
 * Get the list of hub write tool definitions (for inclusion in listTools).
 * Returns MCP Tool objects (name, description, inputSchema).
 */
function getHubWriteToolDefinitions() {
  return hubWriteTools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/**
 * Check if a tool name is a hub write tool.
 */
function isHubWriteTool(name) {
  return hubWriteTools.some(t => t.name === name);
}

module.exports = {
  getHubExecuteToolDefinition,
  handleHubExecute,
  getHubWriteToolDefinitions,
  handleHubWriteTool,
  isHubWriteTool,
};

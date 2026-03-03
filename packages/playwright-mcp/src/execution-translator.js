/**
 * Execution Translator
 *
 * Converts WebMCP Hub execution metadata into Playwright code strings.
 *
 * Strategy:
 * - Text/textarea/number/date fields → page.locator().fill() (Playwright-native,
 *   required for React and other framework-controlled inputs)
 * - Click/submit → page.locator().click() (Playwright-native, required for React)
 * - Select/checkbox/radio with pure CSS selectors → batched into page.evaluate()
 *   (these don't need framework-level event simulation)
 * - Playwright-specific selectors (:has-text, :text, >> chains, etc.)
 *   → always use page.locator() regardless of field type
 * - Waits → page.waitForSelector() (single CDP call each)
 * - Result extraction → page.evaluate() for CSS selectors, page.locator() for Playwright selectors
 *
 * Supports two modes:
 * 1. Simple mode: fields + submit + result extraction
 * 2. Multi-step mode: steps[] array with action sequences
 */

// --- Shadow DOM helpers injected into page.evaluate() batches ---

// Minified on one line so it can be safely embedded inside any page.evaluate() body,
// including inline condition-check expressions.
//
// Source (before minification):
//   function deepQuery(sel, root = document) {
//     const el = root.querySelector(sel);
//     if (el) return el;
//     for (const h of root.querySelectorAll('*')) {
//       if (h.shadowRoot) { const f = deepQuery(sel, h.shadowRoot); if (f) return f; }
//     }
//     return null;
//   }
//   function deepQueryAll(sel, root = document) {
//     const r = [...root.querySelectorAll(sel)];
//     for (const h of root.querySelectorAll('*')) {
//       if (h.shadowRoot) r.push(...deepQueryAll(sel, h.shadowRoot));
//     }
//     return r;
//   }
const DEEP_QUERY_FNS = 'function deepQuery(sel,root=document){const el=root.querySelector(sel);if(el)return el;for(const h of root.querySelectorAll(\'*\')){if(h.shadowRoot){const f=deepQuery(sel,h.shadowRoot);if(f)return f;}}return null;}function deepQueryAll(sel,root=document){const r=[...root.querySelectorAll(sel)];for(const h of root.querySelectorAll(\'*\')){if(h.shadowRoot)r.push(...deepQueryAll(sel,h.shadowRoot));}return r;}';

// Minified visibility check injected alongside DEEP_QUERY_FNS for condition steps.
//
// Source (before minification):
//   function isVisible(el) {
//     if (!el) return false;
//     const s = getComputedStyle(el);
//     if (s.display === 'none') return false;
//     if (s.visibility === 'hidden') return false;
//     if (s.opacity === '0') return false;
//     const r = el.getBoundingClientRect();
//     return !(r.width === 0 && r.height === 0);
//   }
const IS_VISIBLE_FN = 'function isVisible(el){if(!el)return false;const s=getComputedStyle(el);if(s.display===\'none\')return false;if(s.visibility===\'hidden\')return false;if(s.opacity===\'0\')return false;const r=el.getBoundingClientRect();return!(r.width===0&&r.height===0);}';

// --- Playwright selector detection ---

/**
 * Check if a selector uses Playwright-specific syntax that won't work
 * with document.querySelector(). These must use page.locator() instead.
 */
const PW_SELECTOR_RE = /:has-text\(|:text\(|:text-is\(|:text-matches\(|>> |:visible|:nth-match\(|^role=|^text=|^css=|^xpath=/;

function isPlaywrightSelector(sel) {
  return PW_SELECTOR_RE.test(sel);
}

/**
 * Returns true for field types that require native Playwright .fill() to work correctly.
 * DOM value manipulation (page.evaluate) breaks React and other framework-controlled inputs
 * because it bypasses their synthetic event systems. Native Playwright simulates real keyboard
 * input at the browser level, which frameworks respond to correctly.
 */
function isNativeFillType(type) {
  return !type || type === 'text' || type === 'textarea' || type === 'number' || type === 'date';
}

// --- Main entry point ---

/**
 * Translate execution metadata + user-provided arguments into a Playwright code string.
 * Returns a complete `async (page) => { ... }` function string that browser_run_code expects.
 *
 * @param {object} execution - The execution metadata from the hub config tool
 * @param {object} args - The arguments the agent provided when calling the tool
 * @returns {string} Playwright code function to execute via browser_run_code
 */
function translate(execution, args) {
  let body;
  if (execution.steps && execution.steps.length > 0) {
    body = translateSteps(execution, args);
  } else {
    body = translateSimple(execution, args);
  }
  // Wrap in the async (page) => { ... } format that browser_run_code expects
  return `async (page) => {\n  ${body.replace(/\n/g, '\n  ')}\n}`;
}

/**
 * Simple mode: batch field fills + submit, wait, then extract.
 * Playwright selectors get individual Playwright API calls;
 * CSS selectors get batched into page.evaluate().
 */
function translateSimple(execution, args) {
  const phases = [];
  const batch = [];

  function flushBatch() {
    if (batch.length > 0) {
      phases.push(`await page.evaluate(() => {\n  ${DEEP_QUERY_FNS}\n  ${batch.join('\n  ')}\n});`);
      batch.length = 0;
    }
  }

  // Phase 1: Fill fields
  if (execution.fields) {
    for (const field of execution.fields) {
      const value = args[field.name];
      const resolved = value !== undefined ? value : field.defaultValue;
      if (resolved === undefined) continue;

      if (isPlaywrightSelector(field.selector) || isNativeFillType(field.type)) {
        flushBatch();
        phases.push(...playwrightFieldAction(field, resolved));
      } else {
        batch.push(...domFieldAction(field, resolved));
      }
    }
  }

  // Phase 1b: Submit
  if (execution.autosubmit) {
    if (execution.submitAction === 'enter') {
      const lastField = execution.fields && execution.fields.length > 0
        ? execution.fields[execution.fields.length - 1]
        : null;
      const sel = lastField ? lastField.selector : execution.selector;

      if (isPlaywrightSelector(sel)) {
        flushBatch();
        phases.push(`await page.locator(${quote(sel)}).press('Enter');`);
      } else {
        batch.push(
          `{ const _el = deepQuery(${qs(sel)});`,
          `  if (_el) {`,
          `    _el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));`,
          `    _el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }));`,
          `    _el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));`,
          `    const _form = _el.closest('form');`,
          `    if (_form) { _form.requestSubmit ? _form.requestSubmit() : _form.submit(); }`,
          `  }`,
          `}`,
        );
      }
    } else {
      const submitSel = execution.submitSelector || `${execution.selector} [type="submit"], ${execution.selector} button`;
      flushBatch();
      phases.push(`await page.locator(${quote(submitSel)}).first().click();`);
    }
  }

  flushBatch();

  // Phase 2: Wait for results
  addResultWait(phases, execution);

  // Phase 3: Extract results
  addExtraction(phases, execution.resultSelector, execution.resultExtract || 'text', execution.resultAttribute);

  return phases.join('\n');
}

/**
 * Multi-step mode: walk through steps, batching consecutive DOM operations
 * into single page.evaluate() calls. Playwright selectors, waits, navigations,
 * extracts, and conditions break the batch.
 *
 * @param {object} opts.noExtraction - Skip result extraction (used for recursive condition branches)
 */
function translateSteps(execution, args, opts = {}) {
  const phases = [];
  let batch = [];

  function flushBatch() {
    if (batch.length > 0) {
      phases.push(`await page.evaluate(() => {\n  ${DEEP_QUERY_FNS}\n  ${batch.join('\n  ')}\n});`);
      batch = [];
    }
  }

  for (const step of execution.steps) {
    const selector = step.selector ? interpolate(step.selector, args) : null;
    const value = step.value ? interpolate(step.value, args) : null;

    switch (step.action) {
      case 'navigate':
        flushBatch();
        phases.push(`await page.goto(${quote(interpolate(step.url || '', args))});`);
        break;

      case 'click':
        if (selector) {
          flushBatch();
          phases.push(`await page.locator(${quote(selector)}).first().click();`);
        }
        break;

      case 'fill':
        if (selector && value !== null) {
          flushBatch();
          phases.push(`await page.locator(${quote(selector)}).first().fill(${quote(value)});`);
        }
        break;

      case 'select':
        if (selector && value !== null) {
          if (isPlaywrightSelector(selector)) {
            flushBatch();
            phases.push(`await page.locator(${quote(selector)}).first().selectOption(${quote(value)});`);
          } else {
            batch.push(
              `{ const _el = deepQuery(${qs(selector)});`,
              `  if (_el) { _el.value = ${qs(value)}; _el.dispatchEvent(new Event('change', { bubbles: true })); }`,
              `}`,
            );
          }
        }
        break;

      case 'scroll':
        if (selector) {
          if (isPlaywrightSelector(selector)) {
            flushBatch();
            phases.push(`await page.locator(${quote(selector)}).first().scrollIntoViewIfNeeded();`);
          } else {
            batch.push(`deepQuery(${qs(selector)})?.scrollIntoView({ behavior: 'instant' });`);
          }
        }
        break;

      case 'wait':
        flushBatch();
        if (selector) {
          const timeout = step.timeout || 30000;
          if (step.state === 'hidden') {
            phases.push(`await page.waitForSelector(${quote(selector)}, { state: 'hidden', timeout: ${timeout} });`);
          } else {
            phases.push(`await page.waitForSelector(${quote(selector)}, { timeout: ${timeout} });`);
          }
        }
        break;

      case 'extract':
        flushBatch();
        if (selector) {
          addStepExtraction(phases, selector, step.extract || 'text', step.attribute);
        }
        break;

      case 'evaluate':
        flushBatch();
        if (step.value) {
          phases.push(`await page.evaluate(async () => { ${interpolate(step.value, args)} });`);
        }
        break;

      case 'condition':
        flushBatch();
        if (selector) {
          const state = step.state || 'visible';

          if (isPlaywrightSelector(selector)) {
            // Use Playwright locator for condition check
            phases.push(`{`);
            if (state === 'visible') {
              phases.push(`  const _cond = await page.locator(${quote(selector)}).first().isVisible().catch(() => false);`);
            } else if (state === 'hidden') {
              phases.push(`  const _cond = !(await page.locator(${quote(selector)}).first().isVisible().catch(() => false));`);
            } else {
              // exists
              phases.push(`  const _cond = await page.locator(${quote(selector)}).count() > 0;`);
            }
            phases.push(`  if (_cond) {`);
          } else {
            let check;
            if (state === 'exists') {
              check = `deepQuery(${qs(selector)}) !== null`;
            } else if (state === 'visible') {
              check = `isVisible(deepQuery(${qs(selector)}))`;
            } else {
              // hidden: not in DOM OR not visible
              check = `!isVisible(deepQuery(${qs(selector)}))`;
            }
            phases.push(`{`);
            phases.push(`  const _cond = await page.evaluate(() => { ${DEEP_QUERY_FNS} ${IS_VISIBLE_FN} return ${check}; });`);
            phases.push(`  if (_cond) {`);
          }

          if (step.then && step.then.length > 0) {
            const inner = translateSteps({ steps: step.then }, args, { noExtraction: true });
            phases.push('    ' + inner.replace(/\n/g, '\n    '));
          }
          phases.push(`  } else {`);
          if (step.else && step.else.length > 0) {
            const inner = translateSteps({ steps: step.else }, args, { noExtraction: true });
            phases.push('    ' + inner.replace(/\n/g, '\n    '));
          }
          phases.push(`  }`);
          phases.push(`}`);
        }
        break;
    }
  }

  flushBatch();

  // Only add result extraction at the top level, not in recursive condition branches
  if (!opts.noExtraction) {
    addResultWait(phases, execution);
    addExtraction(phases, execution.resultSelector, execution.resultExtract || 'text', execution.resultAttribute);
  }

  return phases.join('\n');
}

// --- Field action generators ---

/**
 * Generate raw DOM JavaScript lines for filling a single field (CSS selectors only).
 * Returns an array of code lines for page.evaluate() body.
 */
function domFieldAction(field, value) {
  const sel = field.selector;
  const lines = [];

  switch (field.type) {
    case 'select':
      lines.push(
        `{ const _el = deepQuery(${qs(sel)});`,
        `  if (_el) { _el.value = ${qs(String(value))}; _el.dispatchEvent(new Event('change', { bubbles: true })); }`,
        `}`,
      );
      break;

    case 'checkbox': {
      const checked = value === true || value === 'true' || value === 'on';
      lines.push(
        `{ const _el = deepQuery(${qs(sel)});`,
        `  if (_el) { _el.checked = ${checked}; _el.dispatchEvent(new Event('change', { bubbles: true })); }`,
        `}`,
      );
      break;
    }

    case 'radio': {
      let radioSel = sel + `[value="${value}"]`;
      if (field.options) {
        const option = field.options.find(o => o.value === String(value));
        if (option && option.selector) radioSel = option.selector;
      }
      lines.push(
        `{ const _el = deepQuery(${qs(radioSel)});`,
        `  if (_el) { _el.checked = true; _el.dispatchEvent(new Event('change', { bubbles: true })); }`,
        `}`,
      );
      break;
    }

    default: // text, number, textarea, date, hidden
      lines.push(
        `{ const _el = deepQuery(${qs(sel)});`,
        `  if (_el) { _el.focus(); _el.value = ${qs(String(value))}; _el.dispatchEvent(new Event('input', { bubbles: true })); _el.dispatchEvent(new Event('change', { bubbles: true })); }`,
        `}`,
      );
      break;
  }

  return lines;
}

/**
 * Generate Playwright API lines for filling a field with Playwright-specific selectors.
 * Returns an array of code lines (each is a standalone statement).
 */
function playwrightFieldAction(field, value) {
  const sel = field.selector;

  switch (field.type) {
    case 'select':
      return [`await page.locator(${quote(sel)}).selectOption(${quote(String(value))});`];

    case 'checkbox':
      if (value === true || value === 'true' || value === 'on') {
        return [`await page.locator(${quote(sel)}).check();`];
      }
      return [`await page.locator(${quote(sel)}).uncheck();`];

    case 'radio': {
      let radioSel = sel + `[value="${value}"]`;
      if (field.options) {
        const option = field.options.find(o => o.value === String(value));
        if (option && option.selector) radioSel = option.selector;
      }
      return [`await page.locator(${quote(radioSel)}).click();`];
    }

    default: // text, number, textarea, date, hidden
      return [`await page.locator(${quote(sel)}).fill(${quote(String(value))});`];
  }
}

// --- Wait helpers ---

/**
 * Add wait-for-results code if specified in execution metadata.
 * page.waitForSelector supports both CSS and Playwright selectors natively.
 */
function addResultWait(phases, execution) {
  if (execution.resultDelay) {
    phases.push(`await new Promise(r => setTimeout(r, ${execution.resultDelay}));`);
  }
  const waitSel = execution.resultWaitSelector;
  if (waitSel) {
    if (execution.resultRequired) {
      // Hard assertion: throws if the selector doesn't appear within 5s.
      // Use resultRequired: true on tools where you need to confirm the action succeeded
      // (e.g. waiting for a success toast after posting). The agent will see the timeout error.
      phases.push(`await page.waitForSelector(${quote(waitSel)}, { timeout: 5000 });`);
    } else {
      // Soft wait: silently continues if the selector doesn't appear.
      // Safe default so tools don't fail when success indicators are optional.
      phases.push(`await page.waitForSelector(${quote(waitSel)}, { timeout: 5000 }).catch(() => {});`);
    }
  }
}

// --- Extraction generators ---

/**
 * Add top-level result extraction.
 * If no resultSelector, returns a neutral acknowledgment without prompting the agent to snapshot.
 */
function addExtraction(phases, selector, extractMode, attribute) {
  if (!selector) {
    phases.push(`return '[action ran — no result selector configured]';`);
    return;
  }
  addStepExtraction(phases, selector, extractMode, attribute);
}

/**
 * Generate extraction code. Uses page.evaluate() for CSS selectors (fast)
 * or page.locator() for Playwright selectors (compatible).
 */
function addStepExtraction(phases, selector, extractMode, attribute) {
  if (isPlaywrightSelector(selector)) {
    addPlaywrightExtraction(phases, selector, extractMode, attribute);
  } else {
    addDomExtraction(phases, selector, extractMode, attribute);
  }
}

/**
 * Extraction via page.evaluate() — for pure CSS selectors.
 * Single CDP round-trip.
 */
function addDomExtraction(phases, selector, extractMode, attribute) {
  switch (extractMode) {
    case 'list':
      phases.push(`{ const _r = await page.evaluate(() => { ${DEEP_QUERY_FNS} return deepQueryAll(${qs(selector)}).map(e => e.textContent); }); return _r.length > 0 ? _r : ['[resultSelector matched no elements — the action may not have worked. Use browser_snapshot to check.]']; }`);
      break;

    case 'innerTextList':
      phases.push(`return await page.evaluate(() => { ${DEEP_QUERY_FNS} return deepQueryAll(${qs(selector)}).map(e => e.innerText); });`);
      break;

    case 'html':
      phases.push(`return await page.evaluate(() => { ${DEEP_QUERY_FNS} return deepQuery(${qs(selector)})?.innerHTML || ''; });`);
      break;

    case 'attribute':
      phases.push(`return await page.evaluate(() => { ${DEEP_QUERY_FNS} return deepQuery(${qs(selector)})?.getAttribute(${qs(attribute || 'href')}) || ''; });`);
      break;

    case 'table':
      phases.push(
        `return await page.evaluate(() => {`,
        `  ${DEEP_QUERY_FNS}`,
        `  const _tbl = deepQuery(${qs(selector)});`,
        `  if (!_tbl) return [];`,
        `  const _headers = [..._tbl.querySelectorAll('th')].map(th => th.textContent.trim());`,
        `  return [..._tbl.querySelectorAll('tr')].slice(1).map(row => {`,
        `    const cells = [...row.querySelectorAll('td')].map(td => td.textContent.trim());`,
        `    return Object.fromEntries(_headers.map((h, i) => [h, cells[i] || '']));`,
        `  });`,
        `});`,
      );
      break;

    case 'innerText':
      phases.push(`return await page.evaluate(() => { ${DEEP_QUERY_FNS} return deepQuery(${qs(selector)})?.innerText || ''; });`);
      break;

    case 'text':
    default:
      phases.push(`return await page.evaluate(() => { ${DEEP_QUERY_FNS} return deepQuery(${qs(selector)})?.textContent || '[resultSelector matched no elements — the action may not have worked. Use browser_snapshot to check.]'; });`);
      break;
  }
}

/**
 * Extraction via page.locator() — for Playwright-specific selectors.
 * Uses Playwright APIs that understand :has-text, :text, >> chains, etc.
 */
function addPlaywrightExtraction(phases, selector, extractMode, attribute) {
  switch (extractMode) {
    case 'list':
      phases.push(`{ const _r = await page.locator(${quote(selector)}).allTextContents(); return _r.length > 0 ? _r : ['[resultSelector matched no elements — the action may not have worked. Use browser_snapshot to check.]']; }`);
      break;

    case 'innerTextList':
      phases.push(`return await page.locator(${quote(selector)}).evaluateAll(els => els.map(e => e.innerText));`);
      break;

    case 'html':
      phases.push(`return await page.locator(${quote(selector)}).first().innerHTML();`);
      break;

    case 'attribute':
      phases.push(`return await page.locator(${quote(selector)}).first().getAttribute(${quote(attribute || 'href')});`);
      break;

    case 'table':
      phases.push(`return await page.locator(${quote(selector)}).evaluate(table => {`);
      phases.push(`  const headers = [...table.querySelectorAll('th')].map(th => th.textContent.trim());`);
      phases.push(`  return [...table.querySelectorAll('tr')].slice(1).map(row => {`);
      phases.push(`    const cells = [...row.querySelectorAll('td')].map(td => td.textContent.trim());`);
      phases.push(`    return Object.fromEntries(headers.map((h, i) => [h, cells[i] || '']));`);
      phases.push(`  });`);
      phases.push(`});`);
      break;

    case 'innerText':
      phases.push(`return await page.locator(${quote(selector)}).first().innerText();`);
      break;

    case 'text':
    default:
      phases.push(`{ const _r = await page.locator(${quote(selector)}).first().textContent().catch(() => null); return _r || '[resultSelector matched no elements — the action may not have worked. Use browser_snapshot to check.]'; }`);
      break;
  }
}

// --- String utilities ---

/**
 * Interpolate {{paramName}} placeholders in a string with argument values.
 */
function interpolate(template, args) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return args[key] !== undefined ? String(args[key]) : `{{${key}}}`;
  });
}

/**
 * Quote a string for Playwright-level code (backtick template literals).
 * Used for page.waitForSelector(), page.goto(), page.locator(), etc.
 */
function quote(str) {
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return '`' + escaped + '`';
}

/**
 * Quote a string for use inside page.evaluate() (JSON double-quoted strings).
 * Safe at any nesting level — no conflicts with backticks or template literals.
 */
function qs(str) {
  return JSON.stringify(str);
}

module.exports = { translate };

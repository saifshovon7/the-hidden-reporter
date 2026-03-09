'use strict';
/**
 * ai-rewriter.js
 * Rewrites raw article content using an OpenAI-compatible AI API.
 * Includes robust JSON parsing with multiple fallback strategies.
 */

const OpenAI = require('openai');
const { config } = require('./config');

let openai;

function getClient() {
  if (!openai) {
    openai = new OpenAI({
      apiKey:  config.ai.apiKey,
      baseURL: config.ai.baseUrl,
    });
  }
  return openai;
}

// ── Strip HTML tags for plain-text input ──────────────────────────────────────
function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Regex-based field extractor (last-resort fallback) ────────────────────────
function extractFieldsByRegex(text) {
  const getString = (key) => {
    // Match "key": "value" — handles escaped chars inside the value
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's');
    const m  = text.match(re);
    if (!m) return '';
    return m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  };

  // Content field may contain HTML with unescaped quotes — extract by position
  let content = getString('content');
  if (!content) {
    const ci = text.indexOf('"content"');
    if (ci !== -1) {
      const valueStart = text.indexOf('"', text.indexOf(':', ci) + 1) + 1;
      const nextField  = text.slice(valueStart).search(/"(?:summary|seo_title|meta_description|tags)"\s*:/);
      if (nextField !== -1) {
        content = text.slice(valueStart, valueStart + nextField).replace(/",?\s*$/, '');
      }
    }
  }

  // Tags array
  let tags = [];
  const tagsMatch = text.match(/"tags"\s*:\s*\[([\s\S]*?)\]/);
  if (tagsMatch) {
    const tagStrings = tagsMatch[1].match(/"([^"]+)"/g);
    if (tagStrings) tags = tagStrings.map(t => t.replace(/"/g, ''));
  }

  return {
    title:            getString('title'),
    content:          content || '',
    summary:          getString('summary'),
    seo_title:        getString('seo_title'),
    meta_description: getString('meta_description'),
    tags,
  };
}

// ── Validate and parse AI response ────────────────────────────────────────────
function parseAiResponse(raw) {
  // 1. Strip markdown fences
  let json = raw.trim()
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  // 2. Extract the outermost JSON object
  const objStart = json.indexOf('{');
  const objEnd   = json.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    json = json.slice(objStart, objEnd + 1);
  }

  let data;

  // 3a. Try direct parse
  try {
    data = JSON.parse(json);
  } catch (_) {
    // 3b. Strip control characters and try again
    const cleaned = json
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // control chars
      .replace(/(?<!\\)\n/g, '\\n')                        // bare newlines → \n
      .replace(/(?<!\\)\r/g, '');                           // bare CR → remove
    try {
      data = JSON.parse(cleaned);
    } catch (_2) {
      // 3c. Last resort — regex field extraction
      console.warn('[AI] JSON.parse failed, using regex field extractor.');
      data = extractFieldsByRegex(json);
    }
  }

  // 4. Validate required fields
  if (!data.title || !data.content) {
    throw new Error('AI response missing required fields (title or content)');
  }

  // 5. Ensure content uses <p> tags
  if (!data.content.includes('<p>')) {
    data.content = data.content
      .split(/\n+/)
      .filter(p => p.trim().length > 20)
      .map(p => `<p>${p.trim()}</p>`)
      .join('\n');
  }

  return {
    title:           (data.title            || '').trim().slice(0, 200),
    content:          data.content          || '',
    summary:         (data.summary          || '').trim().slice(0, 300),
    seoTitle:        (data.seo_title        || data.title || '').trim().slice(0, 60),
    metaDescription: (data.meta_description || data.summary || '').trim().slice(0, 155),
    tags:             Array.isArray(data.tags) ? data.tags.slice(0, 8) : [],
  };
}

// ── Main rewrite function ─────────────────────────────────────────────────────
async function rewriteArticle(rawTitle, rawContent) {
  const client      = getClient();
  const plainText   = stripHtml(rawContent).slice(0, 4000);
  const userMessage = config.rewriter.userPrompt(rawTitle, plainText);

  let attempts = 0;
  const MAX_ATTEMPTS = 3;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    try {
      const completion = await client.chat.completions.create({
        model:           config.ai.model,
        temperature:     0.6,
        max_tokens:      3000,
        response_format: { type: 'json_object' }, // Force valid JSON output
        messages: [
          { role: 'system', content: config.rewriter.systemPrompt },
          { role: 'user',   content: userMessage },
        ],
      });

      const raw = completion.choices?.[0]?.message?.content || '';
      if (!raw) throw new Error('Empty AI response');

      return parseAiResponse(raw);
    } catch (err) {
      console.error(`[AI] Attempt ${attempts} failed: ${err.message}`);
      if (attempts >= MAX_ATTEMPTS) throw err;
      await new Promise(r => setTimeout(r, 2000 * attempts));
    }
  }
}

module.exports = { rewriteArticle };

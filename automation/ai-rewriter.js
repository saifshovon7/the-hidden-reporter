'use strict';
/**
 * ai-rewriter.js
 * Rewrites raw article content using an OpenAI-compatible AI API.
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

// ── Validate and parse AI response ────────────────────────────────────────────
function parseAiResponse(raw) {
  // The model should return JSON, but sometimes wraps it in markdown fences
  let json = raw.trim();
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  const data = JSON.parse(json);

  // Validate required fields
  if (!data.title || !data.content) {
    throw new Error('AI response missing required fields: title or content');
  }

  // Ensure content has <p> tags
  if (!data.content.includes('<p>')) {
    data.content = data.content
      .split(/\n+/)
      .filter(p => p.trim().length > 20)
      .map(p => `<p>${p.trim()}</p>`)
      .join('\n');
  }

  return {
    title:           (data.title           || '').trim().slice(0, 200),
    content:          data.content         || '',
    summary:         (data.summary         || '').trim().slice(0, 300),
    seoTitle:        (data.seo_title       || data.title || '').trim().slice(0, 60),
    metaDescription: (data.meta_description || data.summary || '').trim().slice(0, 155),
    tags:             Array.isArray(data.tags) ? data.tags.slice(0, 8) : [],
  };
}

// ── Main rewrite function ─────────────────────────────────────────────────────
async function rewriteArticle(rawTitle, rawContent) {
  const client      = getClient();
  const plainText   = stripHtml(rawContent);
  const userMessage = config.rewriter.userPrompt(rawTitle, plainText);

  let attempts = 0;
  const MAX_ATTEMPTS = 3;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    try {
      const completion = await client.chat.completions.create({
        model:       config.ai.model,
        temperature: 0.65,
        max_tokens:  2000,
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
      // Exponential backoff: 2s, 4s
      await new Promise(r => setTimeout(r, 2000 * attempts));
    }
  }
}

module.exports = { rewriteArticle };

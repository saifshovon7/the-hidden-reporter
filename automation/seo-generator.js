'use strict';
/**
 * seo-generator.js
 * Generates SEO metadata, slugs, schema markup, and internal linking data.
 */

const slugify = require('slugify');
const { config } = require('./config');

// ── Slug generation ───────────────────────────────────────────────────────────
function generateSlug(title) {
  const base = slugify(title, {
    lower:  true,
    strict: true,
    trim:   true,
  }).slice(0, 80);

  // Append timestamp suffix to ensure uniqueness
  const ts = Date.now().toString(36);
  return `${base}-${ts}`;
}

// ── NewsArticle Schema.org markup ─────────────────────────────────────────────
function generateSchemaMarkup(article) {
  const schema = {
    '@context':         'https://schema.org',
    '@type':            'NewsArticle',
    'headline':          article.seoTitle || article.seo_title || article.title,
    'description':       article.metaDescription || article.meta_description || article.summary || '',
    'datePublished':     (article.publishDate instanceof Date ? article.publishDate.toISOString() : null)
                         || article.publish_date
                         || new Date().toISOString(),
    'dateModified':      new Date().toISOString(),
    'author': {
      '@type': 'Person',
      'name':  article.author || 'The Hidden Reporter Staff',
    },
    'publisher': {
      '@type': 'Organization',
      'name':  config.site.name,
      'logo': {
        '@type': 'ImageObject',
        'url':   `${config.site.url}/logo.png`,
      },
    },
    'mainEntityOfPage': {
      '@type': 'WebPage',
      '@id':   `${config.site.url}/articles/${article.category || 'general'}/${article.slug}.html`,
    },
  };

  const imageUrl = article.featuredImageUrl || article.featured_image_url;
  if (imageUrl) {
    schema.image = {
      '@type': 'ImageObject',
      'url':   imageUrl,
    };
  }

  return JSON.stringify(schema);
}

// ── BreadcrumbList schema ─────────────────────────────────────────────────────
function generateBreadcrumbSchema(article) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type':    'BreadcrumbList',
    'itemListElement': [
      { '@type': 'ListItem', position: 1, name: 'Home',             item: config.site.url },
      { '@type': 'ListItem', position: 2, name: article.category,   item: `${config.site.url}/category/${article.category}.html` },
      { '@type': 'ListItem', position: 3, name: article.title,      item: `${config.site.url}/articles/${article.category || 'general'}/${article.slug}.html` },
    ],
  });
}

// ── Extract topic keywords from tags/content ──────────────────────────────────
const TOPIC_MAP = {
  ai:           ['artificial intelligence', 'machine learning', 'ai', 'openai', 'chatgpt', 'llm'],
  elections:    ['election', 'vote', 'ballot', 'campaign', 'democrat', 'republican'],
  technology:   ['tech', 'software', 'hardware', 'startup', 'silicon valley', 'app'],
  climate:      ['climate', 'global warming', 'carbon', 'emissions', 'environment'],
  economy:      ['economy', 'inflation', 'gdp', 'recession', 'market', 'stock'],
  health:       ['health', 'medical', 'vaccine', 'covid', 'disease', 'hospital'],
  space:        ['space', 'nasa', 'rocket', 'satellite', 'mars', 'moon'],
};

function detectTopics(title, content, tags) {
  const combined = [title, ...(tags || []), content.slice(0, 500)]
    .join(' ')
    .toLowerCase();

  const topics = [];
  for (const [topic, keywords] of Object.entries(TOPIC_MAP)) {
    if (keywords.some(kw => combined.includes(kw))) {
      topics.push(topic);
    }
  }
  return topics;
}

// ── Open Graph tags string ────────────────────────────────────────────────────
function generateOpenGraphTags(article) {
  const articleUrl = `${config.site.url}/articles/${article.category || 'general'}/${article.slug}.html`;
  const ogTitle = article.seoTitle || article.seo_title || article.title;
  const imageUrl = article.featuredImageUrl || article.featured_image_url;
  const lines = [
    `<meta property="og:type" content="article">`,
    `<meta property="og:url" content="${articleUrl}">`,
    `<meta property="og:title" content="${escapeAttr(ogTitle)}">`,
    `<meta property="og:description" content="${escapeAttr(article.metaDescription || article.meta_description || '')}">`,
    `<meta property="og:site_name" content="${escapeAttr(config.site.name)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeAttr(ogTitle)}">`,
    `<meta name="twitter:description" content="${escapeAttr(article.metaDescription || article.meta_description || '')}">`,
  ];
  if (imageUrl) {
    lines.push(`<meta property="og:image" content="${escapeAttr(imageUrl)}">`);
    lines.push(`<meta name="twitter:image" content="${escapeAttr(imageUrl)}">`);
  }
  return lines.join('\n    ');
}

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Main SEO generator ────────────────────────────────────────────────────────
function generateSeoMetadata(article) {
  const slug         = generateSlug(article.title);
  const schemaMarkup = generateSchemaMarkup({ ...article, slug });
  const breadcrumb   = generateBreadcrumbSchema({ ...article, slug });
  const ogTags       = generateOpenGraphTags({ ...article, slug });
  const topics       = detectTopics(article.title, article.content || '', article.tags || []);

  return {
    slug,
    schemaMarkup,
    breadcrumbSchema: breadcrumb,
    ogTags,
    topics,
  };
}

module.exports = { generateSeoMetadata, generateSlug, escapeAttr };

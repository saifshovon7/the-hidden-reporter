# The Hidden Reporter
### *Uncovering stories behind the headlines.*

A fully automated, AI-powered news aggregation website. Fetches articles from multiple RSS/API sources, rewrites them with AI, and publishes static HTML pages to GitHub → Cloudflare Pages.

---

## Project Architecture

```
the-hidden-reporter/
├── public/                     ← Static site (served by Cloudflare Pages)
│   ├── index.html              ← Homepage (auto-regenerated)
│   ├── search.html             ← Client-side search page
│   ├── about.html
│   ├── contact.html
│   ├── editorial-policy.html
│   ├── _redirects              ← Cloudflare Pages routing
│   ├── css/style.css           ← Newspaper stylesheet
│   ├── js/main.js              ← Minimal client JS
│   ├── article/                ← Generated article pages
│   ├── category/               ← Generated category pages
│   ├── topic/                  ← Generated topic cluster pages
│   ├── search-index.json       ← Client-side search index
│   ├── feed.xml                ← RSS feed
│   └── sitemap.xml             ← Auto-generated sitemap
├── automation/                 ← Node.js automation engine
│   ├── index.js                ← Scheduler & pipeline entry point
│   ├── config.js               ← Central configuration
│   ├── fetcher.js              ← RSS + API news fetching
│   ├── extractor.js            ← Article content extraction
│   ├── ai-rewriter.js          ← AI rewriting (OpenAI-compatible)
│   ├── duplicate-detector.js   ← Deduplication logic
│   ├── seo-generator.js        ← SEO metadata & schema markup
│   ├── trending-detector.js    ← Trending topic detection
│   ├── template-generator.js   ← HTML page generation
│   ├── sitemap-generator.js    ← Sitemap builder
│   ├── github-pusher.js        ← GitHub API file pusher
│   ├── cleanup.js              ← 24-month article cleanup
│   └── publisher.js            ← DB save + publish orchestrator
├── database/
│   └── schema.sql              ← Supabase PostgreSQL schema
├── .env.example                ← Environment variable template
├── package.json
└── README.md
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Static HTML + CSS (Instrument Serif) |
| Hosting | Cloudflare Pages |
| Repository | GitHub |
| Database | Supabase (PostgreSQL) |
| Automation | Node.js 18+ |
| AI Rewriting | OpenAI API (gpt-4o-mini or compatible) |
| News Sources | Google News RSS, Direct RSS, NewsAPI (optional) |

---

## Setup Guide

### Step 1 — Create a GitHub Repository

1. Go to [github.com](https://github.com) and create a new repository named `the-hidden-reporter`
2. Set it to **Public**
3. Upload all project files using **GitHub → Add file → Upload files**
4. Upload the `public/` folder contents to the **root** of the repo (or configure Cloudflare Pages to use `public/` as the build output directory)

### Step 2 — Set Up Supabase

1. Go to [supabase.com](https://supabase.com) and create a new project
2. In the **SQL Editor**, paste and run the contents of `database/schema.sql`
3. From **Project Settings → API**, copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** → `SUPABASE_SERVICE_KEY` (keep secret)

### Step 3 — Get an OpenAI API Key

1. Go to [platform.openai.com](https://platform.openai.com)
2. Create an API key → `AI_API_KEY`
3. Recommended model: `gpt-4o-mini` (fast + cheap)

### Step 4 — Create a GitHub Personal Access Token

1. Go to GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. Create a token with **Contents: Read and Write** permission on your repository
3. Copy the token → `GITHUB_TOKEN`

### Step 5 — Connect Cloudflare Pages

1. Go to [pages.cloudflare.com](https://pages.cloudflare.com)
2. Create a new project → **Connect to Git** → select your GitHub repo
3. Settings:
   - **Build command**: *(leave blank — static site)*
   - **Build output directory**: `public`
4. Deploy. Cloudflare will auto-deploy on every GitHub push.

### Step 6 — Configure Environment Variables

Copy `.env.example` to `.env` and fill in all values:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
AI_API_KEY=your-openai-key
AI_MODEL=gpt-4o-mini
GITHUB_TOKEN=your-github-token
GITHUB_OWNER=your-github-username
GITHUB_REPO=the-hidden-reporter
GITHUB_BRANCH=main
SITE_URL=https://your-site.pages.dev
```

### Step 7 — Install Dependencies & Run

```bash
# Install Node.js dependencies
npm install

# Test a single pipeline run
npm run once

# Start continuous scheduler (runs every 45 minutes)
npm start
```

---

## Running the Automation Engine

### Continuous Mode (Production)
```bash
npm start
```
Runs on a cron schedule: every 45 minutes for article fetching, daily at 3:00 AM for cleanup + sitemap.

### Single Run (Testing)
```bash
npm run once
```
Runs one pipeline cycle and exits.

### Manual Cleanup
```bash
npm run cleanup
```

### Manual Sitemap Regeneration
```bash
npm run sitemap
```

### Running on a Server
For production, use a process manager like [PM2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start automation/index.js --name "hidden-reporter"
pm2 save
pm2 startup
```

Or deploy to a cloud VM (DigitalOcean, Render, Railway, Fly.io, etc.).

---

## Database Schema Overview

| Table | Purpose |
|---|---|
| `articles` | All published articles with SEO metadata |
| `sources` | RSS feed sources (managed here or via Supabase dashboard) |
| `images` | Article images with credit |
| `ads` | Advertisement HTML blocks |
| `trending_topics` | Auto-detected trending keywords |
| `processed_urls` | Deduplication cache |

### Managing Ad Content
Edit ads directly in **Supabase → Table Editor → ads**. Supported positions:
- `sidebar` — Right column sidebar
- `in-article` — Injected mid-article
- `footer` — Full-width footer banner

### Adding / Removing Sources
Edit sources in **Supabase → Table Editor → sources**:
- Set `active = false` to disable a source
- Add new rows for additional RSS feeds
- Supported categories: `general`, `technology`, `business`, `science`, `world`, `politics`

---

## Publishing Limits

| Setting | Default | Env Variable |
|---|---|---|
| Max articles per day | 30 | `MAX_ARTICLES_PER_DAY` |
| Fetch interval | 45 min | `FETCH_INTERVAL_MINUTES` |
| Article retention | 24 months | hardcoded |

---

## SEO Features

Every article automatically gets:
- SEO-optimised title (≤ 60 chars)
- Meta description (≤ 155 chars)
- URL slug (`/article/slug-name.html`)
- `NewsArticle` Schema.org markup
- Open Graph + Twitter Card tags
- Breadcrumb schema
- Internal links to related articles
- Topic cluster pages (`/topic/ai.html`, etc.)
- Auto-updated `sitemap.xml`
- RSS feed (`/feed.xml`)

---

## Search

Search is fully client-side. The automation engine generates `/search-index.json` (updated on every publish). The search page (`/search.html`) loads this file and filters articles in the browser. No server required.

Search matches: **title**, **summary**, **category**.

---

## File Structure After Automation Runs

```
public/
├── index.html                      ← Regenerated on every publish
├── search-index.json               ← Updated on every publish
├── feed.xml                        ← Updated on every publish
├── sitemap.xml                     ← Updated daily
├── article/
│   ├── ai-breakthrough-abc123.html
│   ├── global-markets-rise-def456.html
│   └── ...
├── category/
│   ├── technology.html
│   ├── business.html
│   └── ...
└── topic/
    ├── ai.html
    ├── elections.html
    └── ...
```

---

## Customisation

### Change News Sources
Edit `database/schema.sql` (sources seed) or add rows directly in Supabase.

### Change AI Model
Set `AI_MODEL=gpt-4` in `.env` for higher quality, or use any OpenAI-compatible endpoint via `AI_BASE_URL`.

### Change Publish Limit
Set `MAX_ARTICLES_PER_DAY=50` in `.env`.

### Add a Custom Domain
In Cloudflare Pages → **Custom domains** → add your domain, then update `SITE_URL` in `.env`.

### Contact Form
In `public/contact.html`, replace the Formspree `action` URL with your own form endpoint (Formspree, Netlify Forms, etc.).

---

## Deployment Checklist

- [ ] GitHub repository created and files uploaded
- [ ] Supabase project created and `schema.sql` executed
- [ ] Cloudflare Pages connected to GitHub repo
- [ ] `.env` file filled in with all keys
- [ ] `npm install` run successfully
- [ ] `npm run once` test succeeded (articles published to GitHub)
- [ ] Cloudflare Pages deployed successfully
- [ ] `npm start` running on a server / PM2

---

## License

This project is provided as-is for personal and commercial use. Attribution appreciated.

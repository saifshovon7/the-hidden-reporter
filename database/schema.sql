-- ============================================================
-- The Hidden Reporter — Supabase PostgreSQL Schema
-- ============================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================
-- TABLE: sources
-- ============================================================
CREATE TABLE IF NOT EXISTS sources (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_name  TEXT NOT NULL,
  rss_url      TEXT,
  api_url      TEXT,
  source_type  TEXT NOT NULL DEFAULT 'rss',
  website_url  TEXT,
  category     TEXT NOT NULL DEFAULT 'general',
  active       BOOLEAN NOT NULL DEFAULT true,
  priority     INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sources_active ON sources (active);
CREATE INDEX idx_sources_category ON sources (category);
CREATE INDEX idx_sources_type ON sources (source_type);

-- Seed default RSS sources
INSERT INTO sources (source_name, rss_url, source_type, category, active, priority) VALUES
  ('Google News – Top Stories',    'https://news.google.com/rss',           'rss', 'general',    true,  10),
  ('Google News – Technology',     'https://news.google.com/rss/search?q=technology',           'rss', 'technology', true,  10),
  ('Google News – AI',             'https://news.google.com/rss/search?q=artificial+intelligence', 'rss', 'technology', true,  10),
  ('Google News – Business',       'https://news.google.com/rss/search?q=business',              'rss', 'business',   true,  10),
  ('Google News – Science',        'https://news.google.com/rss/search?q=science',               'rss', 'science',    true,  10),
  ('Google News – World',          'https://news.google.com/rss/search?q=world+news',            'rss', 'world',      true,  10),
  ('Google News – Politics',       'https://news.google.com/rss/search?q=politics',              'rss', 'politics',   true,  10),
  ('Google News – Finance',        'https://news.google.com/rss/search?q=finance',               'rss', 'finance',    true,  10),
  ('Google News – Sports',         'https://news.google.com/rss/search?q=sports',                'rss', 'sports',     true,  10),
  ('BBC News',                    'http://feeds.bbci.co.uk/news/rss.xml',  'rss', 'general',    true,  8),
  ('BBC Technology',              'http://feeds.bbci.co.uk/news/technology/rss.xml', 'rss', 'technology', true,  8),
  ('Reuters',                     'https://feeds.reuters.com/reuters/topNews', 'rss', 'general',    true,  9),
  ('TechCrunch',                  'https://techcrunch.com/feed/',          'rss', 'technology', true,  7),
  ('The Verge',                   'https://www.theverge.com/rss/index.xml', 'rss', 'technology', true,  7),
  ('Bloomberg Technology',        'https://feeds.bloomberg.com/technology/news.rss', 'rss', 'technology', false, 5),
  ('NPR News',                    'https://feeds.npr.org/1001/rss.xml',     'rss', 'general',    true,  7),
  ('CNN Top Stories',             'http://rss.cnn.com/rss/edition.rss',    'rss', 'general',    true,  6),
  ('ESPN',                        'https://www.espn.com/espn/rss/news',   'rss', 'sports',     true,  7),
  ('Science Daily',               'https://www.sciencedaily.com/rss/all.xml', 'rss', 'science',   true,  6)
ON CONFLICT DO NOTHING;

-- ============================================================
-- TABLE: articles
-- ============================================================
CREATE TABLE IF NOT EXISTS articles (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title               TEXT NOT NULL,
  slug                TEXT NOT NULL UNIQUE,
  content             TEXT NOT NULL,
  summary             TEXT,
  source_name         TEXT NOT NULL,
  source_url          TEXT NOT NULL UNIQUE,
  source_publish_date TIMESTAMPTZ,
  site_publish_date   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  publish_date        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  view_count          INTEGER NOT NULL DEFAULT 0,
  trend_score         NUMERIC(10, 4) NOT NULL DEFAULT 0,
  category            TEXT NOT NULL DEFAULT 'general',
  tags                TEXT[] DEFAULT '{}',
  seo_title           TEXT,
  meta_description    TEXT,
  schema_markup       TEXT,
  featured_image_url  TEXT,
  featured_image_credit TEXT,
  author              TEXT NOT NULL DEFAULT 'The Hidden Reporter Staff',
  is_breaking         BOOLEAN NOT NULL DEFAULT false,
  related_articles    UUID[] DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_articles_slug          ON articles (slug);
CREATE INDEX idx_articles_category      ON articles (category);
CREATE INDEX idx_articles_publish_date  ON articles (publish_date DESC);
CREATE INDEX idx_articles_view_count    ON articles (view_count DESC);
CREATE INDEX idx_articles_trend_score   ON articles (trend_score DESC);
CREATE INDEX idx_articles_tags          ON articles USING GIN (tags);
CREATE INDEX idx_articles_source_url    ON articles (source_url);

-- Migrate existing databases: add is_breaking if it does not exist
ALTER TABLE articles ADD COLUMN IF NOT EXISTS is_breaking BOOLEAN NOT NULL DEFAULT false;

-- Full-text search index
CREATE INDEX idx_articles_fts ON articles
  USING GIN (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(content,'')));

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER articles_updated_at
  BEFORE UPDATE ON articles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- TABLE: images
-- ============================================================
CREATE TABLE IF NOT EXISTS images (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  article_id  UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  credit      TEXT,
  alt_text    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_images_article_id ON images (article_id);

-- ============================================================
-- TABLE: ads
-- ============================================================
CREATE TABLE IF NOT EXISTS ads (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  position    TEXT NOT NULL,   -- 'sidebar', 'in-article', 'footer'
  title       TEXT,
  content     TEXT NOT NULL,   -- Raw HTML for the ad
  url         TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ads_position ON ads (position, active);

-- Seed placeholder ads
INSERT INTO ads (position, title, content, url, active) VALUES
  ('sidebar',    'Sidebar Ad 1',    '<div class="ad-placeholder"><p>Advertisement</p></div>', '#', true),
  ('in-article', 'In-Article Ad',   '<div class="ad-placeholder"><p>Advertisement</p></div>', '#', true),
  ('footer',     'Footer Ad',       '<div class="ad-placeholder"><p>Advertisement</p></div>', '#', true)
ON CONFLICT DO NOTHING;

-- ============================================================
-- TABLE: trending_topics
-- ============================================================
CREATE TABLE IF NOT EXISTS trending_topics (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  topic         TEXT NOT NULL UNIQUE,
  keyword       TEXT NOT NULL,
  article_count INTEGER NOT NULL DEFAULT 1,
  trend_score   NUMERIC(10, 4) NOT NULL DEFAULT 0,
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trending_score ON trending_topics (trend_score DESC);
CREATE INDEX idx_trending_updated ON trending_topics (last_updated DESC);

-- ============================================================
-- TABLE: processed_urls  (deduplication cache)
-- ============================================================
CREATE TABLE IF NOT EXISTS processed_urls (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  url         TEXT NOT NULL UNIQUE,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_processed_urls ON processed_urls (url);

-- ============================================================
-- ROW LEVEL SECURITY (Supabase)
-- ============================================================

-- Articles: public read, service-role write
ALTER TABLE articles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read articles" ON articles FOR SELECT USING (true);
CREATE POLICY "Service write articles" ON articles FOR ALL USING (auth.role() = 'service_role');

-- Sources: public read, service-role write
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read sources" ON sources FOR SELECT USING (true);
CREATE POLICY "Service write sources" ON sources FOR ALL USING (auth.role() = 'service_role');

-- Ads: public read, service-role write
ALTER TABLE ads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read ads" ON ads FOR SELECT USING (active = true);
CREATE POLICY "Service write ads" ON ads FOR ALL USING (auth.role() = 'service_role');

-- Trending: public read, service-role write
ALTER TABLE trending_topics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read trending" ON trending_topics FOR SELECT USING (true);
CREATE POLICY "Service write trending" ON trending_topics FOR ALL USING (auth.role() = 'service_role');

-- Processed URLs: service-role only
ALTER TABLE processed_urls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service only processed_urls" ON processed_urls FOR ALL USING (auth.role() = 'service_role');

-- Images: public read
ALTER TABLE images ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read images" ON images FOR SELECT USING (true);
CREATE POLICY "Service write images" ON images FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- FUNCTION: increment_view_count
-- ============================================================
CREATE OR REPLACE FUNCTION increment_view_count(article_slug TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE articles SET view_count = view_count + 1 WHERE slug = article_slug;
END;
$$;

-- ============================================================
-- FUNCTION: cleanup_old_articles (older than 24 months)
-- ============================================================
CREATE OR REPLACE FUNCTION cleanup_old_articles()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM articles
    WHERE publish_date < NOW() - INTERVAL '24 months'
    RETURNING id
  )
  SELECT COUNT(*) INTO deleted_count FROM deleted;

  RETURN deleted_count;
END;
$$;

-- ============================================================
-- TABLE: source_stats (track API usage and performance)
-- ============================================================
CREATE TABLE IF NOT EXISTS source_stats (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_name     TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'general',
  articles_fetched INTEGER NOT NULL DEFAULT 0,
  articles_published INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0,
  last_run        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_source_stats_name ON source_stats (source_name);
CREATE INDEX idx_source_stats_date ON source_stats (last_run DESC);

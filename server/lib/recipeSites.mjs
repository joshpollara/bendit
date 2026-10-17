// The household's favourite recipe sites, and what's new on them.
//
// Most recipe blogs run WordPress, which answers /wp-json/wp/v2/posts with the
// latest posts and searches them by relevance — so a WordPress site can be
// browsed and searched. Any other site with an RSS feed shows its latest
// posts. Either way a post is only a link: importing it is the usual import.

import crypto from 'node:crypto';
import { decodeEntities } from './recipeImport.mjs';

const CACHE_MS = 60 * 60 * 1000;
const PER_SITE = 12;

export class SiteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function createRecipeSiteTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS recipe_sites (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, origin TEXT NOT NULL UNIQUE,
    -- 'wordpress' or 'rss'; feedUrl is set for rss.
    kind TEXT NOT NULL, feedUrl TEXT,
    addedBy TEXT NOT NULL, addedAt TEXT NOT NULL
  )`);
}

/** "skinnytaste.com", "https://www.skinnytaste.com/some/page" → "https://www.skinnytaste.com". */
export function originOf(input) {
  const text = String(input ?? '').trim();
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).origin;
  } catch {
    throw new SiteError("That isn't a web address.");
  }
}

/** A post's address without the tracking a feed adds to it ("?utm_source=…", "?adt_ei=…"). */
export function cleanLink(link) {
  try {
    const url = new URL(link);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|adt_)/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return link;
  }
}

const text = (value) => decodeEntities(String(value ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** Posts from a WordPress posts response. */
export function postsFromWordPress(json, site) {
  return (Array.isArray(json) ? json : []).map((post) => ({
    title: text(post.title?.rendered),
    url: cleanLink(post.link),
    image: post.yoast_head_json?.og_image?.[0]?.url ?? post.jetpack_featured_media_url ?? null,
    date: post.date_gmt ? `${post.date_gmt}Z` : (post.date ?? null),
    site: site.name,
  }));
}

const tag = (xml, name) => {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return match ? match[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : null;
};

/** Posts from an RSS or Atom feed. */
export function postsFromFeed(xml, site) {
  const entries = [...String(xml).matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  return entries.map((entry) => {
    const atomLink = /<link[^>]*href=["']([^"']+)["']/i.exec(entry)?.[1];
    const image =
      /<media:(?:content|thumbnail)[^>]*url=["']([^"']+)["']/i.exec(entry)?.[1] ??
      /<enclosure[^>]*type=["']image[^"']*["'][^>]*url=["']([^"']+)["']/i.exec(entry)?.[1] ??
      /<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image/i.exec(entry)?.[1] ??
      null;
    const date = tag(entry, 'pubDate') ?? tag(entry, 'published') ?? tag(entry, 'updated');
    return {
      title: text(tag(entry, 'title')),
      url: cleanLink(decodeEntities(tag(entry, 'link') || atomLink || '')),
      image,
      date: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
      site: site.name,
    };
  });
}

/** What a site calls itself: its og:site_name, else its title up to any tagline. */
export function siteName(html) {
  const og = /<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1];
  return text(og ?? tag(html, 'title') ?? '').split(/\s*[|–:]\s|\s-\s/)[0];
}

/** The feed a page points to, if it does. */
export function feedLinkIn(html, base) {
  const links = [...String(html).matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const feed = links.find(
    (l) => /rel=["']alternate["']/i.test(l) && /application\/(rss|atom)\+xml/i.test(l) && !/comments/i.test(l),
  );
  const href = feed && /href=["']([^"']+)["']/i.exec(feed)?.[1];
  return href ? new URL(decodeEntities(href), base).href : null;
}

export function createRecipeSites(db, { fetchPage, now = () => Date.now() }) {
  const cache = new Map();

  async function json(url) {
    try {
      return JSON.parse(await fetchPage(url));
    } catch {
      return null;
    }
  }

  async function cached(key, load) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.posts;
    const posts = await load();
    cache.set(key, { at: now(), posts });
    return posts;
  }

  const wpPosts = (site, query) => {
    const params = new URLSearchParams({
      per_page: String(PER_SITE),
      _fields: 'title,link,date,date_gmt,yoast_head_json.og_image,jetpack_featured_media_url',
      ...(query ? { search: query, orderby: 'relevance' } : {}),
    });
    return `${site.origin}/wp-json/wp/v2/posts?${params}`;
  };

  /** Latest posts, or a search where the site can search. */
  async function postsOf(site, query) {
    if (site.kind === 'wordpress') {
      return cached(`${site.id}|${query}`, async () => postsFromWordPress(await json(wpPosts(site, query)), site));
    }
    if (query) return [];
    return cached(`${site.id}|`, async () => postsFromFeed(await fetchPage(site.feedUrl).catch(() => ''), site));
  }

  return {
    list: () => db.prepare('SELECT * FROM recipe_sites ORDER BY name COLLATE NOCASE').all(),

    /** Adds a site, working out how to read it. */
    async add(input, { userId }) {
      const origin = originOf(input);
      if (db.prepare('SELECT 1 FROM recipe_sites WHERE origin = ?').get(origin)) {
        throw new SiteError("That site's already on the list.", 409);
      }
      const host = new URL(origin).hostname.replace(/^www\./, '');
      let site;
      const probe = await json(`${origin}/wp-json/wp/v2/posts?per_page=1&_fields=link`);
      if (Array.isArray(probe)) {
        const about = await json(`${origin}/wp-json/?_fields=name`);
        site = { kind: 'wordpress', feedUrl: null, name: text(about?.name) || host };
      } else {
        let page;
        try {
          page = await fetchPage(origin);
        } catch (error) {
          throw new SiteError(error.message);
        }
        const feedUrl = feedLinkIn(page, origin);
        if (!feedUrl) throw new SiteError("Couldn't find a feed of new recipes on that site.");
        site = { kind: 'rss', feedUrl, name: siteName(page) || host };
      }
      const row = {
        id: crypto.randomUUID(),
        origin,
        ...site,
        addedBy: userId,
        addedAt: new Date(now()).toISOString(),
      };
      db.prepare(
        `INSERT INTO recipe_sites (id, name, origin, kind, feedUrl, addedBy, addedAt)
         VALUES (@id, @name, @origin, @kind, @feedUrl, @addedBy, @addedAt)`,
      ).run(row);
      return row;
    },

    remove: (id) => db.prepare('DELETE FROM recipe_sites WHERE id = ?').run(id).changes > 0,

    /**
     * Each site's newest posts, or best matches for a search, taken in turn:
     * one site's tenth doesn't come before another's first, and a site that
     * posts hourly doesn't bury one that posts weekly. Each says whether it's
     * already a recipe here.
     */
    async posts(query = '') {
      const q = String(query).trim().slice(0, 100);
      const sites = this.list();
      const perSite = await Promise.all(sites.map((site) => postsOf(site, q).catch(() => [])));
      const posts = Array.from({ length: PER_SITE }, (_, i) =>
        perSite
          .map((list) => list[i])
          .filter(Boolean)
          // Within a round, newest first; a search keeps each site's own order.
          .sort((a, b) => (q ? 0 : String(b.date).localeCompare(String(a.date)))),
      ).flat();
      const imported = new Set(
        db
          .prepare('SELECT sourceUrl FROM recipes WHERE sourceUrl IS NOT NULL')
          .all()
          .map((r) => r.sourceUrl.replace(/\/$/, '')),
      );
      return posts
        .filter((p) => p.title && /^https?:/.test(p.url))
        .map((p) => ({ ...p, imported: imported.has(p.url.replace(/\/$/, '')) }));
    },
  };
}

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cleanLink,
  createRecipeSiteTables,
  createRecipeSites,
  feedLinkIn,
  originOf,
  postsFromFeed,
  siteName,
} from './recipeSites.mjs';

const WP_POSTS = [
  {
    title: { rendered: 'Turkey Chili &#8211; Slow Cooker' },
    link: 'https://wp.test/turkey-chili/?adt_ei=*|EMAIL|*',
    date_gmt: '2026-10-15T10:00:00',
    yoast_head_json: { og_image: [{ url: 'https://wp.test/chili.jpg' }] },
  },
  { title: { rendered: 'Apple Cake' }, link: 'https://wp.test/apple-cake/', date_gmt: '2026-10-10T10:00:00' },
];

const RSS = `<?xml version="1.0"?><rss><channel><title>Feedy</title>
  <item><title><![CDATA[Lentil Soup]]></title><link>https://rss.test/lentil-soup?utm_source=rss</link>
    <pubDate>Fri, 16 Oct 2026 15:50:00 +0000</pubDate>
    <media:content url="https://rss.test/soup.jpg" medium="image"/></item>
</channel></rss>`;

const RSS_HOME = `<html><head><title>Feedy | Recipes for everyone</title>
  <link rel="alternate" type="application/rss+xml" title="Comments" href="/comments/feed/">
  <link rel="alternate" type="application/rss+xml" title="Feed" href="/feed/"></head></html>`;

/** wp.test runs WordPress; rss.test only has a feed. */
function fakeFetch() {
  const asked = [];
  const fetchPage = async (url) => {
    asked.push(url);
    if (url.startsWith('https://wp.test/wp-json/wp/v2/posts')) {
      const search = new URL(url).searchParams.get('search');
      return JSON.stringify(search ? WP_POSTS.slice(0, 1) : WP_POSTS);
    }
    if (url.startsWith('https://wp.test/wp-json/')) return JSON.stringify({ name: 'Wordy' });
    if (url.startsWith('https://rss.test/wp-json')) throw new Error('That page returned 404.');
    if (url === 'https://rss.test') return RSS_HOME;
    if (url === 'https://rss.test/feed/') return RSS;
    throw new Error(`unexpected ${url}`);
  };
  return { fetchPage, asked };
}

let db;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE recipes (sourceUrl TEXT)');
  createRecipeSiteTables(db);
});

describe('reading sites', () => {
  it('takes a site from however it was typed', () => {
    expect(originOf('skinnytaste.com')).toBe('https://skinnytaste.com');
    expect(originOf('https://www.skinnytaste.com/some/recipe/')).toBe('https://www.skinnytaste.com');
  });

  it('drops the tracking a feed adds to links', () => {
    expect(cleanLink('https://a.test/soup/?adt_ei=*|EMAIL|*&utm_source=x&page=2')).toBe('https://a.test/soup/?page=2');
  });

  it("finds a site's feed and short name, not its comments feed or tagline", () => {
    expect(feedLinkIn(RSS_HOME, 'https://rss.test')).toBe('https://rss.test/feed/');
    expect(siteName(RSS_HOME)).toBe('Feedy');
  });

  it('reads posts from a feed', () => {
    expect(postsFromFeed(RSS, { name: 'Feedy' })).toEqual([
      {
        title: 'Lentil Soup',
        url: 'https://rss.test/lentil-soup',
        image: 'https://rss.test/soup.jpg',
        date: '2026-10-16T15:50:00.000Z',
        site: 'Feedy',
      },
    ]);
  });
});

describe('the household sites', () => {
  it('adds a WordPress site and a feed-only site', async () => {
    const sites = createRecipeSites(db, fakeFetch());
    expect(await sites.add('wp.test', { userId: 'ann' })).toMatchObject({ name: 'Wordy', kind: 'wordpress' });
    expect(await sites.add('https://rss.test/anything', { userId: 'ann' })).toMatchObject({
      name: 'Feedy',
      kind: 'rss',
      feedUrl: 'https://rss.test/feed/',
    });
    await expect(sites.add('https://wp.test/', { userId: 'ann' })).rejects.toThrow(/already/);
  });

  it('lists the newest from each site in turn, and marks what is already imported', async () => {
    const sites = createRecipeSites(db, fakeFetch());
    await sites.add('wp.test', { userId: 'ann' });
    await sites.add('rss.test', { userId: 'ann' });
    db.prepare('INSERT INTO recipes VALUES (?)').run('https://wp.test/apple-cake');
    const posts = await sites.posts();
    expect(posts.map((p) => [p.title, p.imported])).toEqual([
      ['Lentil Soup', false],
      ['Turkey Chili – Slow Cooker', false],
      ['Apple Cake', true],
    ]);
  });

  it('searches the sites that can be searched', async () => {
    const sites = createRecipeSites(db, fakeFetch());
    await sites.add('wp.test', { userId: 'ann' });
    await sites.add('rss.test', { userId: 'ann' });
    expect((await sites.posts('chili')).map((p) => p.title)).toEqual(['Turkey Chili – Slow Cooker']);
  });

  it('asks each site once an hour', async () => {
    const fake = fakeFetch();
    const sites = createRecipeSites(db, fake);
    await sites.add('rss.test', { userId: 'ann' });
    await sites.posts();
    await sites.posts();
    expect(fake.asked.filter((u) => u === 'https://rss.test/feed/')).toHaveLength(1);
  });
});

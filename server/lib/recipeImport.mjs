// Getting a recipe out of a web page.
//
// Most recipe sites publish schema.org/Recipe as JSON-LD in the page, because
// that is what puts them in search results. It carries the ingredients and the
// yield exactly as the author wrote them. Reading it costs nothing, can't
// misread a number, and doesn't call a model — so it is tried first, and the
// model is the fallback for pages that have none.
//
// Fetching a URL a user supplies means the server will connect wherever it is
// pointed, so where it may point is limited: public HTTP(S) only, no redirects
// into private space, and a size and time cap on what comes back.

import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/** Addresses inside the network the server sits in, which no recipe lives at. */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // link-local, and cloud metadata
      (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT, Fly's internal range
    );
  }
  const ip6 = ip.toLowerCase();
  return (
    ip6 === '::1' ||
    ip6 === '::' ||
    ip6.startsWith('fc') ||
    ip6.startsWith('fd') || // unique local, which is Fly's private network
    ip6.startsWith('fe80')
  );
}

/** Throws unless the URL is a public web address. */
export async function assertFetchable(url, { resolver = dns } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('That is not a web address.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be read.');
  }

  // URL keeps an IPv6 host in its brackets — "[::1]" — which is not an address
  // as far as net.isIP is concerned, so it would have gone to DNS and slipped
  // past the check entirely.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const literal = net.isIP(host) ? [host] : null;
  const addresses =
    literal ?? (await resolver.lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0) throw new Error("That address doesn't resolve.");
  if (addresses.some(isPrivateAddress)) {
    throw new Error('That address is inside this server’s own network.');
  }
  return parsed;
}

/** Fetches a page, capped in time and size. */
export async function fetchPage(url, { fetchImpl = fetch, resolver = dns } = {}) {
  await assertFetchable(url, { resolver });
  const response = await fetchImpl(url, {
    redirect: 'error', // a redirect could land somewhere the check didn't see
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      // Sites serve a different page to something that looks like a crawler.
      'user-agent': 'Mozilla/5.0 (compatible; BenditRecipeReader/1.0)',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!response.ok) throw new Error(`That page returned ${response.status}.`);

  const text = await response.text();
  return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
}

const decodeEntities = (text) =>
  String(text ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ');

/** Every JSON-LD block in the page, flattened out of @graph and arrays. */
function jsonLdNodes(html) {
  const nodes = [];
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const [, body] of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      continue; // a malformed block is one site's problem, not the page's
    }
    const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
      nodes.push(node);
    }
  }
  return nodes;
}

const isRecipe = (node) => {
  const type = node['@type'];
  return Array.isArray(type) ? type.includes('Recipe') : type === 'Recipe';
};

/** "4 servings", "Serves 4-6", "4" — the number of portions, if it says one. */
export function readYield(value) {
  if (value == null) return null;
  const text = Array.isArray(value) ? value.join(' ') : String(value);
  // "Serves 4 to 6" is a range; take the middle, as with an ingredient range.
  const range = /(\d+)\s*(?:-|–|to)\s*(\d+)/.exec(text);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const single = /(\d+(?:\.\d+)?)/.exec(text);
  return single ? Number(single[1]) : null;
}

const asLines = (value) =>
  (Array.isArray(value) ? value : [value])
    .flatMap((item) => {
      if (typeof item === 'string') return item;
      if (item?.text) return item.text;
      if (Array.isArray(item?.itemListElement)) return item.itemListElement.map((s) => s.text ?? s);
      return [];
    })
    .map((line) => decodeEntities(String(line)).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

/**
 * The recipe a page declares about itself, or null when it declares none.
 * Nothing here is inferred: every field is one the page stated.
 */
export function recipeFromJsonLd(html) {
  const node = jsonLdNodes(html).find(isRecipe);
  if (!node) return null;

  const ingredients = asLines(node.recipeIngredient ?? node.ingredients ?? []);
  if (ingredients.length === 0) return null;

  const servings = readYield(node.recipeYield);
  const nutrition = node.nutrition && typeof node.nutrition === 'object'
    ? {
        calories: readYield(node.nutrition.calories),
        protein: readYield(node.nutrition.proteinContent),
        carbs: readYield(node.nutrition.carbohydrateContent),
        fat: readYield(node.nutrition.fatContent),
      }
    : null;
  return {
    name: decodeEntities(node.name ?? '').trim() || 'Recipe',
    ingredients,
    instructions: asLines(node.recipeInstructions ?? []).join('\n') || null,
    servings,
    servingsStated: servings != null,
    sourceNutrition: nutrition?.calories != null ? nutrition : null,
    source: 'json-ld',
  };
}

/** The page's visible text, for handing to a model when it declared nothing. */
export function pageText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, '\n'),
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 12_000);
}

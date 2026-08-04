import { describe, expect, it } from 'vitest';
import { assertFetchable, pageText, readYield, recipeFromJsonLd } from './recipeImport.mjs';

// The JSON-LD fixtures are the shapes real recipe sites publish: a bare object,
// one wrapped in @graph, a @type that is an array, instructions as objects.

const page = (jsonLd, body = '') =>
  `<!DOCTYPE html><html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body>${body}</body></html>`;

const BOLOGNESE = {
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Spaghetti bolognese',
  recipeYield: '4 servings',
  recipeIngredient: ['2 tbsp olive oil', '1 onion, finely chopped', '500g beef mince'],
  recipeInstructions: [
    { '@type': 'HowToStep', text: 'Fry the onion.' },
    { '@type': 'HowToStep', text: 'Add the mince.' },
  ],
};

describe('recipeFromJsonLd', () => {
  it('reads what the page declares about itself', () => {
    const recipe = recipeFromJsonLd(page(BOLOGNESE));
    expect(recipe.name).toBe('Spaghetti bolognese');
    expect(recipe.ingredients).toHaveLength(3);
    expect(recipe.servings).toBe(4);
    expect(recipe.servingsStated).toBe(true);
    expect(recipe.instructions).toBe('Fry the onion.\nAdd the mince.');
  });

  it('finds the recipe inside a @graph, where most sites put it', () => {
    const wrapped = { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite' }, BOLOGNESE] };
    expect(recipeFromJsonLd(page(wrapped))?.name).toBe('Spaghetti bolognese');
  });

  it('copes with a @type that is a list', () => {
    const multi = { ...BOLOGNESE, '@type': ['Recipe', 'NewsArticle'] };
    expect(recipeFromJsonLd(page(multi))?.ingredients).toHaveLength(3);
  });

  it('takes ingredients as plain strings too', () => {
    const plain = { ...BOLOGNESE, recipeInstructions: 'Cook it all.' };
    expect(recipeFromJsonLd(page(plain))?.instructions).toBe('Cook it all.');
  });

  it('unescapes what the page escaped', () => {
    const escaped = { ...BOLOGNESE, recipeIngredient: ['2 tbsp cr&#232;me fra&#238;che'] };
    expect(recipeFromJsonLd(page(escaped))?.ingredients[0]).toBe('2 tbsp crème fraîche');
  });

  it('says nothing rather than something when the page declares no recipe', () => {
    expect(recipeFromJsonLd(page({ '@type': 'WebSite', name: 'A blog' }))).toBeNull();
    expect(recipeFromJsonLd('<html><body>just a page</body></html>')).toBeNull();
  });

  it('ignores a recipe with no ingredients, which is not a recipe', () => {
    expect(recipeFromJsonLd(page({ '@type': 'Recipe', name: 'Empty' }))).toBeNull();
  });

  it('survives a malformed block instead of throwing', () => {
    const broken = `<script type="application/ld+json">{not json}</script>${page(BOLOGNESE)}`;
    expect(recipeFromJsonLd(broken)?.name).toBe('Spaghetti bolognese');
  });

  it('leaves servings unknown when the page never says', () => {
    const { recipeYield, ...noYield } = BOLOGNESE;
    const recipe = recipeFromJsonLd(page(noYield));
    expect(recipe.servings).toBeNull();
    expect(recipe.servingsStated).toBe(false);
  });
});

describe('readYield', () => {
  it('reads the ways a yield is written', () => {
    expect(readYield('4 servings')).toBe(4);
    expect(readYield('Serves 6')).toBe(6);
    expect(readYield(['4', '4 servings'])).toBe(4);
    expect(readYield(4)).toBe(4);
  });

  it('takes the middle of a range', () => {
    expect(readYield('Serves 4-6')).toBe(5);
    expect(readYield('4 to 6 portions')).toBe(5);
  });

  it('has no answer for a yield with no number', () => {
    expect(readYield('a big bowl')).toBeNull();
    expect(readYield(null)).toBeNull();
  });
});

describe('pageText', () => {
  it('strips markup, scripts and styles', () => {
    const html = '<html><script>var x=1</script><style>p{}</style><body><h1>Title</h1><p>Line</p></body></html>';
    expect(pageText(html)).toBe('Title\nLine');
  });
});

describe('assertFetchable', () => {
  // The one that matters: a URL a user types must not become a request into
  // the server's own network.
  const resolving = (address) => ({ lookup: async () => [{ address }] });

  it('accepts an ordinary public address', async () => {
    await expect(assertFetchable('https://example.com/recipe', { resolver: resolving('93.184.216.34') }))
      .resolves.toBeTruthy();
  });

  it('refuses anything that resolves inside the network', async () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '172.16.0.1', '::1', 'fdaa::3']) {
      await expect(
        assertFetchable('https://sneaky.example/recipe', { resolver: resolving(address) }),
        address,
      ).rejects.toThrow(/own network/);
    }
  });

  it('refuses a private address written directly', async () => {
    await expect(assertFetchable('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/own network/);
    await expect(assertFetchable('http://[::1]:8080/')).rejects.toThrow(/own network/);
  });

  it('refuses schemes that are not the web', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com']) {
      await expect(assertFetchable(url), url).rejects.toThrow(/http/);
    }
  });

  it('refuses something that is not an address at all', async () => {
    await expect(assertFetchable('not a url')).rejects.toThrow(/not a web address/);
  });
});

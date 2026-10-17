import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageText } from './Assistant';

describe('assistant messages', () => {
  it('makes markdown links and bare addresses tappable, and drops bold markers', () => {
    const html = renderToStaticMarkup(
      createElement(MessageText, {
        text: '1. **[Lentil Curry](https://cook.test/curry/)** - 45 min\nMore at https://cook.test/more.',
      }),
    );
    expect(html).toContain('<a href="https://cook.test/curry/" target="_blank" rel="noreferrer"');
    expect(html).toContain('>Lentil Curry</a>');
    expect(html).toContain('<a href="https://cook.test/more" target="_blank"');
    expect(html).toContain('</a>.');
    expect(html).not.toContain('**');
  });
});

// The brand files the app serves (public/, built by brand/build.sh) must match
// tokens.css and brand/, and index.html must point at files that exist.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { siteMetaTags, SOCIAL_CARD } from '../server/siteMeta';

const viz = (p: string) => path.join(process.cwd(), p);
const read = (p: string) => readFileSync(viz(p), 'utf8');
const token = (name: string) => {
  const m = read('src/ui/tokens.css').match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!m) throw new Error(`no --${name} in tokens.css`);
  return m[1].toUpperCase();
};

describe('brand wiring', () => {
  it('public copies are byte-identical to brand/', () => {
    for (const [pub, src] of [
      ['public/favicon.svg', '../brand/favicon.svg'],
      ['public/manifest.webmanifest', '../brand/manifest.webmanifest'],
      ['public/social-card.png', '../brand/social-card.png'],
      ['public/icon-192.png', '../brand/icon-192.png'],
      ['public/icon-512.png', '../brand/icon-512.png'],
      ['public/apple-touch-icon.png', '../brand/icon-180.png'],
    ]) {
      expect(readFileSync(viz(pub)).equals(readFileSync(viz(src))), `${pub} differs from ${src}: run brand/build.sh`).toBe(true);
    }
  });

  it('favicon, manifest and theme-color use the current tokens', () => {
    const fav = read('public/favicon.svg');
    for (const t of ['bg', 'text', 'slime']) expect(fav, `favicon lacks --${t}: run brand/build.sh`).toContain(token(t));
    const man = JSON.parse(read('public/manifest.webmanifest'));
    expect(man.theme_color).toBe(token('bg'));
    expect(man.background_color).toBe(token('bg'));
    for (const icon of man.icons) expect(existsSync(viz(`public${icon.src}`)), icon.src).toBe(true);
    const html = read('index.html');
    expect(html.match(/name="theme-color" content="(#[0-9A-Fa-f]{6})"/)?.[1].toUpperCase()).toBe(token('bg'));
  });

  it('index.html links only files that exist in public/', () => {
    const html = read('index.html');
    const hrefs = [...html.matchAll(/<link[^>]+href="(\/[^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(expect.arrayContaining(['/favicon.svg', '/apple-touch-icon.png', '/manifest.webmanifest']));
    for (const h of hrefs) expect(existsSync(viz(`public${h}`)), h).toBe(true);
  });

  it('adds absolute og:image only when SITE_URL is set', () => {
    expect(siteMetaTags(undefined)).toEqual([]);
    expect(siteMetaTags('')).toEqual([]);
    const tags = siteMetaTags('https://spores.example');
    const get = (k: string) => tags.find((t) => t.attrs?.property === k || t.attrs?.name === k)?.attrs?.content;
    expect(get('og:image')).toBe(`https://spores.example${SOCIAL_CARD}`);
    expect(get('twitter:image')).toBe(get('og:image'));
    expect(get('og:url')).toBe('https://spores.example/');
    expect(() => siteMetaTags('ftp://spores.example')).toThrow(/http/);
  });
});

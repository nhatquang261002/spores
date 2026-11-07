// Build-time head tags that need the site's absolute URL (link previews ignore a
// relative og:image). Set SITE_URL when building for a deployed host; without it
// nothing is added and index.html keeps only its relative tags. The card is
// public/social-card.png, built by brand/build.sh.
import type { HtmlTagDescriptor, Plugin } from 'vite';

export const SOCIAL_CARD = '/social-card.png';

/** The absolute-URL tags for `siteUrl`, or none if it is unset. Exported for tests. */
export function siteMetaTags(siteUrl: string | undefined): HtmlTagDescriptor[] {
  if (!siteUrl) return [];
  const base = new URL(siteUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error(`SITE_URL must be http(s): ${siteUrl}`);
  const image = new URL(SOCIAL_CARD, base).href;
  const meta = (attr: 'property' | 'name', key: string, content: string): HtmlTagDescriptor => ({
    tag: 'meta',
    attrs: { [attr]: key, content },
    injectTo: 'head',
  });
  return [
    meta('property', 'og:url', new URL('/', base).href),
    meta('property', 'og:image', image),
    meta('property', 'og:image:width', '1200'),
    meta('property', 'og:image:height', '630'),
    meta('property', 'og:image:alt', 'Spore #5 at epoch 17, rendered from its on-chain state'),
    meta('name', 'twitter:image', image),
  ];
}

export function siteMetaPlugin(siteUrl = process.env.SITE_URL): Plugin {
  return {
    name: 'spores-site-meta',
    transformIndexHtml: () => siteMetaTags(siteUrl),
  };
}

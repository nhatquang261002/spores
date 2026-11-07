// Gallery tile (Design §6.B, §7): the art dominates; state, image-hash badge,
// name, epoch and stats sit inside the art frame over scrims, owner and price
// in the meta row below. The whole card is one link to /spore/:id.
import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { imageBadge, type GallerySpore, type ImageBadge, type RenderedImage } from '../model/gallery';
import { formatNear, formatR, shortAccount, shortHash } from '../ui/format';
import { useCloseSwell } from '../ui/motion';
import { hex, paletteOf } from '../ui/tokens';
import { Tooltip } from '../ui/Tooltip';
import { artKey, SporeArtwork } from './SporeArtwork';
import { StateMarker, stateWords } from './StateMarker';

const MAX_PARTNERS = 8;

/** `partners #3 #12 #40` (by id), `+N` past eight. */
export function partnersText(tubes: [number, string][]): string {
  if (tubes.length === 0) return 'no tubes';
  const ids = tubes.map(([n]) => n).sort((a, b) => a - b);
  const shown = ids.slice(0, MAX_PARTNERS).map((n) => `#${n}`).join(' ');
  return `partners ${shown}${ids.length > MAX_PARTNERS ? ` +${ids.length - MAX_PARTNERS}` : ''}`;
}

const BADGE_WORDS: Record<ImageBadge, string> = {
  match: 'image verified',
  mismatch: 'image hash mismatch',
  none: 'no image commit',
  older: 'older image commit',
  'other-renderer': 'image committed with another renderer',
  checking: 'checking image',
};

/** "Spore #7, active, epoch 17, degree 4, reputation 1.43, listed 0.80 NEAR, image verified" (Design §6.B). */
export function cardLabel(s: GallerySpore, badge: ImageBadge): string {
  const o = s.organism;
  return [
    `Spore #${o.id}`,
    stateWords(s.status),
    `epoch ${s.image.stateEpoch}`,
    `degree ${o.tubes.length}`,
    `reputation ${formatR(o.reputation)}`,
    ...(s.holding.listedPrice ? [`listed ${formatNear(s.holding.listedPrice)}`] : []),
    BADGE_WORDS[badge],
  ].join(', ');
}

/** `R 1.43 · 4 tubes · age 17 · 1 prior sale` (Design §6.F); no trend, floor or ROI. */
export function listingStats(s: GallerySpore): string {
  const o = s.organism;
  const sales = s.holding.sales;
  return [
    `R ${formatR(o.reputation)}`,
    `${o.tubes.length} tube${o.tubes.length === 1 ? '' : 's'}`,
    `age ${o.age}`,
    ...(sales === null ? [] : [`${sales} prior sale${sales === 1 ? '' : 's'}`]),
  ].join(' · ');
}

function BadgeMark({ badge, spore, rendered }: { badge: ImageBadge; spore: GallerySpore; rendered: RenderedImage | null }) {
  const c = spore.image.commit;
  const e = spore.image.stateEpoch;
  const [glyph, word, tip] = (() => {
    switch (badge) {
      case 'match':
        return ['✓', 'image', `This browser rendered the epoch ${e} state and got the committed hash ${shortHash(c!.imageHash)}.`];
      case 'mismatch':
        return ['✕', 'image', `This browser rendered ${shortHash(rendered!.imageHash)} for the epoch ${e} state; the contract has ${shortHash(c!.imageHash)} committed.`];
      case 'none':
        return ['○', 'no commit', 'No image has been committed for this spore.'];
      case 'older':
        return ['◷', 'older commit', `The commit is for epoch ${c!.epoch}; the state is now epoch ${e}. Verify the older commit on the Spore page.`];
      case 'other-renderer':
        return ['!', `renderer v${c!.rendererVersion}`, `Committed with renderer v${c!.rendererVersion}; this app renders v${rendered!.rendererVersion}, so the hashes can't be compared.`];
      case 'checking':
        return [null, 'checking…', `Rendering the epoch ${e} state to compare with the committed hash ${shortHash(c!.imageHash)}.`];
    }
  })();
  return (
    <Tooltip align="end" focusable={false} content={tip}>
      <span className={`image-badge badge-${badge}`}>
        {glyph && <span aria-hidden="true">{glyph}</span>} {word}
      </span>
    </Tooltip>
  );
}

export function SporeCard({
  spore,
  to,
  tabIndex,
  priority = 1,
  stale = false,
  viewTransition = true,
  onArt,
  from,
  variant = 'default',
  action,
}: {
  spore: GallerySpore;
  to: string;
  /** Roving focus: 0 for the grid's current card, -1 for the rest. */
  tabIndex: 0 | -1;
  priority?: number;
  /** Polling has failed: values keep the stale styling (Design §4.2). */
  stale?: boolean;
  viewTransition?: boolean;
  /** Each render (or failure) for the card's current art key. */
  onArt?: (id: number, key: string) => void;
  /** The Spore page's breadcrumb (Design §5.4). */
  from?: { label: string; to: string };
  /** `listing` = MarketplaceListing (Design §6.F): price and seller, then R, tubes, age and prior sales. */
  variant?: 'default' | 'listing';
  /** Rendered under the card, outside its link (Buy). */
  action?: ReactNode;
}) {
  const o = spore.organism;
  const key = artKey(o);
  const [rendered, setRendered] = useState<(RenderedImage & { key: string }) | null>(null);
  // Only a render of the state shown counts; the previous image's hash never meets the new commit.
  const current = rendered && rendered.key === key ? rendered : null;
  const badge = imageBadge(spore.image, current);
  const accent = hex(paletteOf(o.seed).stops[3]);
  // The name swells when a close raised R and thins when it fell (Design §3.5).
  const swell = useCloseSwell(spore.image.stateEpoch, o.reputation);

  return (
    <li className="gallery-item" style={{ '--accent': accent } as CSSProperties}>
      <Link
        to={to}
        className="spore-card"
        tabIndex={tabIndex}
        aria-label={cardLabel(spore, badge)}
        viewTransition={viewTransition}
        state={from ? { from } : undefined}
        data-stale={stale || undefined}
        data-id={o.id}
      >
        <div className="card-art" style={{ viewTransitionName: viewTransition ? `spore-art-${o.id}` : undefined }}>
          <SporeArtwork
            organism={o}
            glyph={spore.glyph}
            variant="card"
            priority={priority}
            onRendered={(r) => {
              setRendered({ key: r.key, imageHash: r.imageHash, rendererVersion: r.rendererVersion });
              onArt?.(o.id, r.key);
            }}
            onFailed={(r) => onArt?.(o.id, r.key)}
          />
          <div className="card-overlay" aria-hidden="true">
            <div className="card-top mono-s">
              <StateMarker reading={spore.status} focusable={false} />
              <BadgeMark badge={badge} spore={spore} rendered={current} />
            </div>
            <div className="card-bottom">
              <p className="card-partners mono-s">{partnersText(o.tubes)}</p>
              <div className="card-name-row">
                <span className="display-s card-name" key={swell.n} data-swell={swell.dir ?? undefined}>
                  Spore #{o.id}
                </span>
                <span className="mono-s card-epoch">epoch {spore.image.stateEpoch}</span>
              </div>
              <p className="mono-s card-stats">
                deg {o.tubes.length} · R {formatR(o.reputation)}
              </p>
            </div>
          </div>
        </div>
        {variant === 'listing' && spore.holding.listedPrice ? (
          <div className="card-meta card-meta-listing" aria-hidden="true">
            <p className="card-listing-line">
              <span className="figure card-price">{formatNear(spore.holding.listedPrice)}</span>
              <span className="mono-s card-owner">{shortAccount(spore.holding.owner)}</span>
            </p>
            <p className="mono-s card-listing-stats">{listingStats(spore)}</p>
          </div>
        ) : (
          <div className="card-meta" aria-hidden="true">
            <span className="mono-s card-owner">{shortAccount(spore.holding.owner)}</span>
            {spore.holding.listedPrice && <span className="mono card-price">{formatNear(spore.holding.listedPrice)}</span>}
          </div>
        )}
      </Link>
      {action && <div className="card-action">{action}</div>}
    </li>
  );
}

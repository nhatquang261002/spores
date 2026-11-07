// A spore's state as glyph + word (Design §1.5, §6.B): never colour alone.
// Derived states carry the ≈ mark (§4.2). `Activated` is the bulk-view
// reading when the policy is not in the source (team decision, S6).
import type { SporeStatus, StatusReading } from '../model/types';
import { Tooltip } from '../ui/Tooltip';

export const STATE_MARKS: Record<SporeStatus, { glyph: string; word: string; tip: string }> = {
  active: { glyph: '●', word: 'Active', tip: 'Activated, and its policy is not paused.' },
  dormant: { glyph: '○', word: 'Dormant', tip: 'Minted, never activated. There is no way back to dormant once activated.' },
  paused: { glyph: '‖', word: 'Paused', tip: 'Activated, with its policy paused: its agent cannot spend.' },
  'awaiting-policy': { glyph: '◌', word: 'Awaiting policy', tip: 'Activated with an operator, but the owner has not set a policy yet.' },
  'control-reset': {
    glyph: '↺',
    word: 'Control reset',
    tip: 'Derived in your browser: paused with no operator, which only a transfer or sale does (control reset).',
  },
  activated: {
    glyph: '◉',
    word: 'Activated',
    tip: 'The collection views show it was activated. Whether its policy is active, paused or reset after a transfer is on the Spore page.',
  },
};

/** "active", "derived control reset": for accessible names. */
export function stateWords(r: StatusReading): string {
  return `${r.derived ? 'derived ' : ''}${STATE_MARKS[r.status].word.toLowerCase()}`;
}

export function StateMarker({ reading, focusable = true }: { reading: StatusReading; focusable?: boolean }) {
  const m = STATE_MARKS[reading.status];
  return (
    <Tooltip content={m.tip} focusable={focusable}>
      <span className={`state-marker state-${reading.status}`}>
        {reading.derived && (
          <span className="derived-mark" aria-hidden="true">
            ≈{' '}
          </span>
        )}
        <span className="state-glyph" aria-hidden="true">
          {m.glyph}
        </span>{' '}
        {m.word}
      </span>
    </Tooltip>
  );
}

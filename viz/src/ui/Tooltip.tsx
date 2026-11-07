// Tooltip (Design §7): opens on hover and on focus after 400 ms, or at once on
// click/tap (touch has no hover); role=tooltip, max 280 px; Escape dismisses
// it (WCAG 1.4.13). Used instead of the native `title`, which keyboard and
// touch users never see.
//
// The bubble is portalled to <body> and placed with `position: fixed` from the
// anchor's rectangle, so no ancestor's stacking context, overflow or transform
// can put it underneath something: it is always the top layer (--z-tooltip).
// React events still bubble through the portal, so moving the pointer from the
// anchor onto the bubble does not close it.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const TOOLTIP_DELAY_MS = 400;

const GAP = 8;
const MARGIN = 8;

/** Fixed position for the bubble: below the anchor (above when there is no room), kept inside the viewport. */
function place(anchor: HTMLElement, bubble: HTMLElement, align: 'start' | 'end'): CSSProperties {
  let r = anchor.getBoundingClientRect();
  // A zero-size anchor (an absolutely positioned child inside it) is measured by that child.
  const child = anchor.firstElementChild;
  if (r.width === 0 && r.height === 0 && child) r = child.getBoundingClientRect();
  const { width, height } = bubble.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let left = align === 'end' ? r.right - width : r.left;
  left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN));
  let top = r.bottom + GAP;
  const above = r.top - GAP - height;
  if (top + height > vh - MARGIN && above >= MARGIN) top = above;
  top = Math.max(MARGIN, top);
  return { left, top, visibility: 'visible' };
}

export function Tooltip({
  content,
  children,
  align = 'start',
  focusable = true,
}: {
  content: ReactNode;
  /** A node, or a function that puts `aria-describedby` on its own focusable element (e.g. a button). */
  children: ReactNode | ((describedBy: string | undefined) => ReactNode);
  /** `end` keeps it inside the viewport for anchors at the right edge. */
  align?: 'start' | 'end';
  /** Make the anchor a tab stop. Pass false when the child is focusable itself. */
  focusable?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({ left: 0, top: 0, visibility: 'hidden' });
  const anchorRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), TOOLTIP_DELAY_MS);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  const toggle = () => {
    clearTimeout(timer.current);
    setOpen((o) => !o);
  };

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Measure before paint (the bubble is hidden until placed), and follow scroll and resize while open.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (anchorRef.current && bubbleRef.current) setPos(place(anchorRef.current, bubbleRef.current, align));
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      setPos({ left: 0, top: 0, visibility: 'hidden' });
    };
  }, [open, align, content]);

  const describedBy = open ? id : undefined;
  return (
    <span
      ref={anchorRef}
      className="tip-anchor"
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={typeof children === 'function' ? undefined : describedBy}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={toggle}
    >
      {typeof children === 'function' ? children(describedBy) : children}
      {open &&
        createPortal(
          <span ref={bubbleRef} role="tooltip" id={id} className={`tooltip tooltip-${align} body`} style={pos}>
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}

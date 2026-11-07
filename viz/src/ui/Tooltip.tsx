// Tooltip (Design §7): opens on hover and on focus after 400 ms, or at once on
// click/tap (touch has no hover); role=tooltip, max 280 px; Escape dismisses
// it (WCAG 1.4.13). Used instead of the native `title`, which keyboard and
// touch users never see.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export const TOOLTIP_DELAY_MS = 400;

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

  const describedBy = open ? id : undefined;
  return (
    <span
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
      {open && (
        <span role="tooltip" id={id} className={`tooltip tooltip-${align} body`}>
          {content}
        </span>
      )}
    </span>
  );
}

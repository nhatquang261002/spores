// Modal for every wallet action (Design §7 `ConfirmationDialog`, §9): a
// labelled dialog on the dialog layer, focus moved in and trapped, Escape and
// the backdrop close it unless the caller says it can't close (a tx in
// flight), and focus returns to the opener. The rest of the app is inert
// while it is open.
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmationDialog({
  title,
  onClose,
  closable = true,
  variant = 'default',
  children,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  /** False while a transaction is signing or pending: Escape and the backdrop do nothing. */
  closable?: boolean;
  variant?: 'default' | 'danger';
  children: ReactNode;
  footer: ReactNode;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef({ closable, onClose });
  latest.current = { closable, onClose };

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box.current)?.focus();
    return () => {
      root?.removeAttribute('inert');
      opener?.focus?.();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (latest.current.closable) latest.current.onClose();
      return;
    }
    if (e.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      items[items.length - 1].focus();
    } else if (!e.shiftKey && i === items.length - 1) {
      e.preventDefault();
      items[0].focus();
    }
  };

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && latest.current.closable && latest.current.onClose()}>
      <div
        className={`dialog dialog-${variant}`}
        role={variant === 'danger' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        ref={box}
        onKeyDown={onKeyDown}
      >
        <h2 className="title" id={`${id}-title`}>
          {title}
        </h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-footer">{footer}</div>
      </div>
    </div>,
    document.body,
  );
}

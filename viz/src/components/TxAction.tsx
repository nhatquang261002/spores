// A wallet call (Design §7 `TxAction`, §8.3, §6.F): the button, its
// ConfirmationDialog (method, arguments, deposit, consequences) and the
// state machine of model/tx.ts. The wallet signs and sends; the app reads the
// final outcome itself and only then shows `✓ Confirmed` (or the contract's
// error verbatim). Disabled while signing or pending; a disabled action says
// why (the router's words when the router would refuse).
import { useEffect, useReducer, useRef, type ReactNode } from 'react';
import { EXPLORER, RpcError } from '../chain/rpc';
import type { Router } from '../chain/router';
import type { FunctionCall } from '../chain/wallet';
import type { Gate } from '../model/actions';
import { IDLE, isBusy, isWalletCancel, outcomeOf, txCopy, txReduce, type TxOutcome } from '../model/tx';
import { signerOf, useWallet } from '../state/wallet';
import { ConfirmationDialog } from '../ui/ConfirmationDialog';
import { formatNear, shortHash } from '../ui/format';
import { Tooltip } from '../ui/Tooltip';
import { useTxTray, type TxState } from '../ui/TxTray';

const RETRY_CAUSES = new Set(['UNKNOWN_TRANSACTION', 'TIMEOUT_ERROR']);
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The final outcome of a just-sent tx (`tx`, wait_until FINAL). A node that
 * hasn't seen it yet says UNKNOWN_TRANSACTION; that is retried, anything else
 * is thrown (the dialog then says the result is not known yet).
 */
export async function finalOutcome(router: Router, hash: string, signer: string, failEvents: string[] = [], tries = 6, sleep = realSleep): Promise<TxOutcome> {
  for (let i = 0; ; i++) {
    try {
      return outcomeOf(await router.rpc.tx(hash, signer), failEvents);
    } catch (e) {
      const retry = e instanceof RpcError && RETRY_CAUSES.has(e.causeName ?? '');
      if (!retry || i + 1 >= tries) throw e;
      await sleep(2000);
    }
  }
}

/** "1 yoctoNEAR, required by the contract for security" (Design §6.D.1). */
export function depositText(yocto: string): string {
  if (yocto === '0') return 'none';
  if (yocto === '1') return '1 yoctoNEAR, required by the contract for security';
  return formatNear(yocto);
}

export type Draft = FunctionCall | { error: string };

let txSeq = 0;

export function TxAction({
  router,
  sporeId,
  verb,
  button,
  variant = 'secondary',
  gate,
  draft,
  fields,
  consequences,
  failEvents,
  okNote,
  onOpen,
  onFinal,
}: {
  router: Router;
  sporeId: number;
  /** Dialog title: `${verb} Spore #N`. */
  verb: string;
  button: string;
  variant?: 'primary' | 'secondary' | 'danger';
  gate: Gate;
  /** The call the form describes, or why it can't be sent yet. */
  draft: Draft;
  fields?: ReactNode;
  consequences: ReactNode;
  /** Router events that mean the call did not take effect (`withdraw_failed`). */
  failEvents?: string[];
  /** Shown under `✓ Confirmed`. */
  okNote?: ReactNode;
  onOpen?: () => void;
  /** After a final outcome (ok or failed): the page rereads its views. */
  onFinal?: (o: TxOutcome) => void;
}) {
  const wallet = useWallet();
  const tray = useTxTray();
  const [m, dispatch] = useReducer(txReduce, IDLE);
  const trayId = useRef('');
  const call = 'error' in draft ? null : draft;
  const title = txCopy({ phase: 'confirm' }, verb, sporeId);
  const latest = useRef({ onFinal, failEvents });
  latest.current = { onFinal, failEvents };

  // The tray mirrors the machine from signing on (Design §7 TxTray).
  useEffect(() => {
    if (m.phase === 'idle' || m.phase === 'confirm' || !trayId.current) return;
    tray.upsert({ id: trayId.current, label: title, state: m.phase as TxState, hash: m.hash, error: m.error });
  }, [m.phase, m.hash, m.error, m.checkError]);

  const check = async (hash: string, signer: string) => {
    try {
      const o = await finalOutcome(router, hash, signer, latest.current.failEvents);
      dispatch({ type: 'final', outcome: o });
      latest.current.onFinal?.(o);
    } catch (e) {
      dispatch({ type: 'checkFailed', error: String((e as Error)?.message ?? e) });
    }
  };

  const sign = async () => {
    const signer = signerOf(wallet);
    if (!call || !signer || !gate.ok || isBusy(m)) return;
    trayId.current = `tx-${++txSeq}`;
    dispatch({ type: 'sign' });
    let hash: string;
    try {
      hash = await wallet.client.send(signer, router.id, call);
    } catch (e) {
      dispatch({ type: 'walletError', error: String((e as Error)?.message ?? e), cancelled: isWalletCancel(e) });
      return;
    }
    dispatch({ type: 'sent', hash });
    await check(hash, signer);
  };

  const open = () => {
    if (!gate.ok) return;
    onOpen?.();
    dispatch({ type: 'open' });
  };
  const close = () => dispatch({ type: 'close' });
  const busy = isBusy(m);
  const editable = m.phase === 'confirm' || m.phase === 'cancelled' || m.phase === 'failed';
  const btnClass = `btn ${variant === 'primary' ? 'btn-primary' : 'btn-secondary'}`;

  const trigger = gate.ok ? (
    <button type="button" className={btnClass} onClick={open} disabled={busy}>
      {button}
    </button>
  ) : (
    <Tooltip focusable={false} content={gate.contract ? <span className="mono">{gate.reason}</span> : gate.reason}>
      {(describedBy) => (
        <button type="button" className={btnClass} aria-disabled="true" aria-describedby={describedBy}>
          {button}
        </button>
      )}
    </Tooltip>
  );

  const link = m.hash && (
    <a className="mono" href={`${EXPLORER}/${m.hash}`} target="_blank" rel="noreferrer">
      tx {shortHash(m.hash)} ↗
    </a>
  );

  return (
    <>
      {trigger}
      {m.phase !== 'idle' && (
        <ConfirmationDialog
          title={title}
          onClose={close}
          closable={!busy}
          variant={variant === 'danger' ? 'danger' : 'default'}
          footer={
            m.phase === 'ok' ? (
              <button type="button" className="btn btn-primary" onClick={close} data-autofocus>
                Close
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
                  Cancel
                </button>
                {m.phase === 'pending' && m.checkError ? (
                  <button type="button" className="btn btn-primary" onClick={() => void check(m.hash!, signerOf(wallet) ?? '')}>
                    Check again
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={() => void sign()} disabled={!editable || !call || !gate.ok}>
                    {m.phase === 'failed' || m.phase === 'cancelled' ? 'Try again' : 'Sign in wallet'}
                  </button>
                )}
              </>
            )
          }
        >
          {editable && fields && <fieldset className="tx-fields">{fields}</fieldset>}
          {editable && 'error' in draft && <p className="body tx-draft-error">{draft.error}</p>}
          <dl className="tx-call">
            <dt className="label">Method</dt>
            <dd className="mono">
              {call?.method ?? '—'} <span className="unavailable">on {router.id}</span>
            </dd>
            <dt className="label">Arguments</dt>
            <dd>
              <code className="mono tx-args">{call ? JSON.stringify(call.args) : '—'}</code>
            </dd>
            <dt className="label">Attached deposit</dt>
            <dd className="mono">
              {call ? (
                <Tooltip content={<span className="mono">{call.deposit} yoctoNEAR</span>}>
                  <span>{depositText(call.deposit)}</span>
                </Tooltip>
              ) : (
                '—'
              )}
            </dd>
            <dt className="label">Gas limit</dt>
            <dd className="mono">{call ? `${call.gasTgas} Tgas` : '—'}</dd>
          </dl>
          <div className="tx-consequences body">{consequences}</div>
          {m.phase !== 'confirm' && (
            <div className={`tx-status tx-${m.phase}`} role="status" aria-live={m.phase === 'failed' ? 'assertive' : 'polite'}>
              <p className="body">
                {m.phase === 'pending' && <span className="tx-spinner" aria-hidden="true" />}
                {m.phase === 'failed' ? (
                  <>
                    <span aria-hidden="true">✕</span> Failed: <span className="mono">{m.error}</span>
                  </>
                ) : (
                  txCopy(m, verb, sporeId)
                )}{' '}
                {link}
              </p>
              {m.phase === 'pending' && m.checkError && (
                <p className="body">
                  The wallet sent it, but its final outcome could not be read yet: <span className="mono">{m.checkError}</span>
                </p>
              )}
              {m.phase === 'failed' && (
                <p className="body">
                  {m.hash
                    ? 'The transaction failed, so the spore did not change. Read the reason, then change the form or close.'
                    : 'The wallet returned this error and no transaction hash.'}
                </p>
              )}
              {m.phase === 'ok' && okNote}
            </div>
          )}
        </ConfirmationDialog>
      )}
    </>
  );
}

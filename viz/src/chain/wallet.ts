// Wallet integration (plan S8; VERIFY notes in docs/verify-notes.md "Phase 6
// S8"): NEAR's current connector, @hot-labs/near-connect 0.12.0, on testnet,
// offering only wallets whose manifest says they support testnet and
// signAndSendTransaction. The package is imported on the first wallet
// interaction (Design §10), or at load when an earlier visit connected.
//
// The wallet signs and sends; the app then reads the final outcome itself
// (`Rpc.tx`, wait_until FINAL), so success is never the wallet's word alone.

/** One function call on the router. Amounts are yocto strings. */
export interface FunctionCall {
  method: string;
  args: object;
  /** Attached deposit in yoctoNEAR. */
  deposit: string;
  gasTgas: number;
}

export interface WalletClient {
  /** The account connected in an earlier visit, if the wallet still has it. Loads the connector. */
  restore(): Promise<string | null>;
  /** Opens the wallet picker; resolves with the account id. */
  connect(): Promise<string>;
  disconnect(): Promise<void>;
  /** Signs and sends one call from `signer`; resolves with the tx hash once the wallet has sent it. */
  send(signer: string, receiver: string, call: FunctionCall): Promise<string>;
}

const TGAS = 1_000_000_000_000n;

/** `signAndSendTransaction` params in the connector's (wallet-selector) action format. */
export function connectorTx(signer: string, receiver: string, c: FunctionCall) {
  return {
    network: 'testnet' as const,
    signerId: signer,
    receiverId: receiver,
    actions: [
      {
        type: 'FunctionCall' as const,
        params: { methodName: c.method, args: c.args, gas: (BigInt(c.gasTgas) * TGAS).toString(), deposit: c.deposit },
      },
    ],
  };
}

/** The hash in whatever the wallet returned (a FinalExecutionOutcome, per the connector's types). */
export function hashOf(result: any): string {
  const h = result?.transaction?.hash ?? result?.transaction_outcome?.id;
  if (typeof h !== 'string' || !h) throw new Error('the wallet returned no transaction hash');
  return h;
}

/** Testnet only (Rules). A named mainnet account can't sign here; implicit (hex) accounts exist on both. */
export function isWrongNetwork(account: string): boolean {
  return account.endsWith('.near');
}

type Connector = import('@hot-labs/near-connect').NearConnector;

export function nearConnectWallet(): WalletClient {
  let connector: Promise<Connector> | null = null;
  const load = () =>
    (connector ??= import('@hot-labs/near-connect').then(
      (m) =>
        new m.NearConnector({
          network: 'testnet',
          features: { testnet: true, signAndSendTransaction: true },
          autoConnect: true,
          footerBranding: null,
        }),
      (e) => {
        connector = null;
        throw e;
      },
    ));

  return {
    async restore() {
      const c = await load();
      try {
        const { accounts } = await c.getConnectedWallet();
        return accounts[0]?.accountId ?? null;
      } catch {
        return null; // no wallet connected in this browser
      }
    },
    async connect() {
      const c = await load();
      const wallet = await c.connect();
      const accounts = await wallet.getAccounts({ network: 'testnet' });
      const id = accounts[0]?.accountId;
      if (!id) throw new Error('the wallet returned no account');
      return id;
    },
    async disconnect() {
      const c = await load();
      await c.disconnect();
    },
    async send(signer, receiver, call) {
      const c = await load();
      const wallet = await c.wallet();
      return hashOf(await wallet.signAndSendTransaction(connectorTx(signer, receiver, call) as any));
    },
  };
}

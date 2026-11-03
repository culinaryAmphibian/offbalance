// Sign the server's canonical challenge verbatim; reject unrelated signing requests.
export function createSignInMessage({ message, address, chainId }) {
  if (typeof address !== 'string' || !/^0x[\da-f]{40}$/i.test(address) || !Number.isSafeInteger(chainId) || chainId < 1) {
    throw new Error('Invalid wallet or sign-in challenge.');
  }
  const expected = /^Sign in to OffBalance\n\nWallet: (0x[\da-f]{40})\nNonce: ([\da-f]{32})$/i.exec(message);
  if (!expected || expected[1].toLowerCase() !== address.toLowerCase()) {
    throw new Error('The server returned an invalid sign-in challenge for this wallet.');
  }
  return message;
}

// MetaMask wraps node errors as -32603 "Internal JSON-RPC error"; the node's own message is nested in data.
function innerMessage(error) {
  const candidates = [error?.data?.message, error?.data?.data?.message, error?.data?.cause?.message,
    error?.cause?.message, error?.data?.originalError?.message];
  return candidates.find(text => typeof text === 'string' && text.trim()) ?? null;
}

export function walletError(error) {
  if (error?.code === 4001) return 'Wallet request declined. You can try again.';
  if (error?.code === -32002) return 'A wallet request is already open. Check your wallet.';
  const inner = innerMessage(error);
  const text = inner ?? error?.message ?? '';
  // The dev chain restarts fresh, but MetaMask remembers each account's old transaction count.
  if (/nonce (too (high|low)|has already been used)|invalid nonce|nonce.*expected/i.test(text)) {
    return 'Your wallet\'s transaction count is out of sync with the chain (it was probably restarted). In MetaMask: Settings → Advanced → Clear activity tab data, then try again.';
  }
  const reverted = /reverted with reason string '([^']+)'|execution reverted:?\s*(.+)/i.exec(text);
  if (reverted) return `The contract rejected the transaction: ${(reverted[1] ?? reverted[2]).trim()}`;
  if (inner) return inner;
  return error?.message || 'Could not sign in. Try again.';
}

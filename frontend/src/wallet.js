export function createSignInMessage({ address, chainId, nonce, issuedAt = new Date().toISOString() }, location = window.location) {
  if (typeof address !== 'string' || address.length !== 42 || !/^0x[\da-f]{40}$/i.test(address) || !Number.isSafeInteger(chainId) || chainId < 1 || typeof nonce !== 'string' || nonce.length < 8 || /[^a-z\d]/i.test(nonce)) {
    throw new Error('Invalid wallet or sign-in challenge.');
  }
  if (typeof issuedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(issuedAt) || /\s/.test(issuedAt) || Number.isNaN(Date.parse(issuedAt))) throw new Error('Invalid sign-in timestamp.');
  return `${location.host} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Offbalance.\n\nURI: ${location.origin}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
}

export function walletError(error) {
  if (error.code === 4001) return 'Wallet request declined. You can try again.';
  if (error.code === -32002) return 'A wallet request is already open. Check your wallet.';
  return error.message || 'Could not sign in. Try again.';
}

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

export function walletError(error) {
  if (error.code === 4001) return 'Wallet request declined. You can try again.';
  if (error.code === -32002) return 'A wallet request is already open. Check your wallet.';
  return error.message || 'Could not sign in. Try again.';
}

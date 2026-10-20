import { useCallback, useEffect, useRef, useState } from "react";
import { createSignInMessage, walletError } from "./wallet";

export function useAuth(api, demo) {
	const [session, setSession] = useState(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const generation = useRef(0);
	const [provider, setProvider] = useState(() => window.ethereum);
	const identity = useRef(null);

	const disconnect = useCallback(
		(message = "") => {
			generation.current++;
			identity.current = null;
			void api.logout?.().catch(() => {});
			api.setToken(null);
			setSession(null);
			setPending(false);
			setError(message);
		},
		[api],
	);

	useEffect(() => {
		api.onUnauthorized = () =>
			disconnect("Your session expired. Sign in again.");
		return () => {
			api.onUnauthorized = null;
		};
	}, [api, disconnect]);

	useEffect(() => {
		const wallet = provider;
		const changed = () => {
			if (identity.current)
				disconnect("Your wallet changed. Sign in again.");
		};
		wallet?.on?.("accountsChanged", changed);
		wallet?.on?.("chainChanged", changed);
		wallet?.on?.("disconnect", changed);
		return () => {
			for (const event of [
				"accountsChanged",
				"chainChanged",
				"disconnect",
			])
				wallet?.removeListener?.(event, changed);
		};
	}, [provider, disconnect]);

	useEffect(
		() => () => {
			generation.current++;
		},
		[],
	);

	useEffect(() => {
		if (!session?.expiresAt) return;
		let timer;
		function checkExpiry() {
			const remaining = Date.parse(session.expiresAt) - Date.now();
			if (remaining <= 0)
				disconnect("Your session expired. Sign in again.");
			else
				timer = setTimeout(
					checkExpiry,
					Math.min(remaining, 2147483647),
				);
		}
		checkExpiry();
		return () => clearTimeout(timer);
	}, [session, disconnect]);

	async function connect() {
		const attempt = ++generation.current;
		identity.current = null;
		setPending(true);
		setError("");
		let verified;
		try {
			if (demo) {
				verified = await api.demoLogin();
			} else {
				const wallet = provider || window.ethereum;
				if (!wallet)
					throw new Error(
						"No Ethereum wallet found. Install a browser wallet to sign in.",
					);
				if (wallet !== provider) setProvider(wallet);
				const [address] = await wallet.request({
					method: "eth_requestAccounts",
				});
				const chain = await wallet.request({ method: "eth_chainId" });
				const chainId = Number(chain);
				identity.current = { address, chainId };
				const challenge = await api.nonce(address, chainId);
				if (attempt !== generation.current) return;
				const signingAddress = challenge.wallet || address;
				if (signingAddress.toLowerCase() !== address.toLowerCase())
					throw new Error(
						"The sign-in challenge belongs to a different wallet.",
					);
				const message = createSignInMessage({
					...challenge,
					address: signingAddress,
					chainId,
				});
				const signature = await wallet.request({
					method: "personal_sign",
					params: [toHex(message), address],
				});
				const [current] = await wallet.request({
					method: "eth_accounts",
				});
				const currentChain = await wallet.request({
					method: "eth_chainId",
				});
				if (
					current?.toLowerCase() !== address.toLowerCase() ||
					Number(currentChain) !== chainId
				)
					throw new Error("Your wallet changed. Sign in again.");
				if (attempt !== generation.current) return;
				verified = await api.verify(address, signature);
				if (attempt !== generation.current) {
					void api.logout?.(verified.token).catch(() => {});
					return;
				}
				if (
					verified.account?.wallet?.toLowerCase() !==
					address.toLowerCase()
				)
					throw new Error(
						"The server returned a different wallet. Try signing in again.",
					);
			}
			if (attempt !== generation.current) return;
			if (
				!verified.token ||
				!verified.account?.wallet ||
				!verified.account?.id ||
				(verified.expiresAt !== undefined && (
					!Number.isFinite(Date.parse(verified.expiresAt)) ||
					Date.parse(verified.expiresAt) <= Date.now()
				))
			) {
				throw new Error("The server returned an invalid session.");
			}
			api.setToken(verified.token);
			setSession(verified);
		} catch (problem) {
			if (verified?.token) void api.logout?.(verified.token).catch(() => {});
			if (attempt === generation.current) setError(walletError(problem));
		} finally {
			if (attempt === generation.current) setPending(false);
		}
	}

	return { session, pending, error, connect, disconnect };
}

function toHex(text) {
	return `0x${Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

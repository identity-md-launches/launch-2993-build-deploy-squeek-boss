// @ts-check
/**
 * Wallets without a relay: desktop extensions by EIP-6963, phones by opening this page in a
 * wallet's own browser. Only a message signature is ever requested: no chain, no transaction.
 */

/**
 * @typedef {{ request: (args: { method: string, params?: unknown[] }) => Promise<any>,
 *   on?: (event: string, fn: (...a: any[]) => void) => void }} Eip1193
 * @typedef {{ id: string, rdns: string, name: string, icon: string | null, provider: Eip1193 }} Wallet
 */

/** @type {Map<string, Wallet>} */
const found = new Map();
/** @type {Set<() => void>} */
const subscribers = new Set();

export function startDiscovery() {
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = /** @type {any} */ (event).detail;
    if (!detail || !detail.info || !detail.info.uuid || !detail.provider) return;
    const { uuid, rdns, name, icon } = detail.info;
    found.set(uuid, { id: uuid, rdns: String(rdns || uuid), name: String(name || "Wallet"), icon: icon || null, provider: detail.provider });
    subscribers.forEach((fn) => fn());
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** @param {() => void} fn */
export function onWallets(fn) {
  subscribers.add(fn);
}

/** Wallets EIP-6963 named; the generic injected provider only when discovery named none. */
export function listWallets() {
  /** @type {Wallet[]} */
  const list = [...found.values()];
  const injected = /** @type {any} */ (window).ethereum;
  if (!list.length && injected) list.push({ id: "injected", rdns: "injected", name: "Browser wallet", icon: null, provider: injected });
  return list;
}

/** A phone or tablet browser with no injected provider: the case the links exist for. */
export const isMobileBrowser = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && !(/** @type {any} */ (window).ethereum);

const COINBASE_MARK = `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="28" height="28" fill="#2C5FF6"/><path fill-rule="evenodd" clip-rule="evenodd" d="M14 23.8C19.4124 23.8 23.8 19.4124 23.8 14C23.8 8.58761 19.4124 4.2 14 4.2C8.58761 4.2 4.2 8.58761 4.2 14C4.2 19.4124 8.58761 23.8 14 23.8ZM11.55 10.8C11.1358 10.8 10.8 11.1358 10.8 11.55V16.45C10.8 16.8642 11.1358 17.2 11.55 17.2H16.45C16.8642 17.2 17.2 16.8642 17.2 16.45V11.55C17.2 11.1358 16.8642 10.8 16.45 10.8H11.55Z" fill="white"/></svg>`;

/** Neutral wallet glyph for rows whose official mark is not bundled. */
const WALLET_GLYPH = `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="28" height="28" rx="6" fill="#1c2136"/><rect x="5" y="8" width="18" height="13" rx="3" stroke="#eef1ff" stroke-width="1.6"/><path d="M5 11h18" stroke="#eef1ff" stroke-width="1.6"/><circle cx="18.5" cy="16" r="1.4" fill="#b8ff3c"/></svg>`;

/** @param {string} svg */
export const svgUri = (svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
export const GLYPH_URI = svgUri(WALLET_GLYPH);

/** Each link is the one its vendor documents; none needs a project ID or a server. */
export const OPEN_IN = [
  // https://docs.metamask.io/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks
  { id: "metamask", name: "MetaMask", icon: GLYPH_URI, href: (/** @type {string} */ url) => `https://link.metamask.io/dapp/${url.replace(/^https?:\/\//, "")}` },
  // https://docs.cdp.coinbase.com/wallet-sdk/docs/deep-link
  { id: "coinbase", name: "Coinbase Wallet", icon: svgUri(COINBASE_MARK), href: (/** @type {string} */ url) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}` },
  // https://docs.phantom.com/phantom-deeplinks/other-methods/browse
  {
    id: "phantom",
    name: "Phantom",
    icon: GLYPH_URI,
    href: (/** @type {string} */ url) => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(new URL(url).origin)}`,
  },
];

/** @param {Eip1193} provider @returns {Promise<string>} */
export async function requestAccount(provider) {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || !accounts[0]) throw new Error("The wallet returned no account.");
  return String(accounts[0]);
}

/** Already-authorised account, without a prompt. @param {Eip1193} provider */
export async function silentAccount(provider) {
  try {
    const accounts = await provider.request({ method: "eth_accounts" });
    return Array.isArray(accounts) && accounts[0] ? String(accounts[0]) : null;
  } catch {
    return null;
  }
}

/** @param {string} text */
export function utf8Hex(text) {
  return "0x" + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** EIP-191 personal_sign. @param {Eip1193} provider @param {string} address @param {string} message */
export async function signMessage(provider, address, message) {
  const sig = await provider.request({ method: "personal_sign", params: [utf8Hex(message), address] });
  if (typeof sig !== "string" || !sig.startsWith("0x")) throw new Error("The wallet returned no signature.");
  return sig;
}

/** @param {unknown} err */
export function walletErrorText(err) {
  const e = /** @type {any} */ (err);
  if (e && (e.code === 4001 || /reject|denied|cancel/i.test(String(e.message)))) return "Request declined in the wallet. Nothing was sent; try again when ready.";
  if (e && e.code === -32002) return "A wallet prompt is already open. Finish it in the wallet first.";
  return `The wallet answered with an error: ${e && e.message ? String(e.message).slice(0, 120) : "unknown error"}.`;
}

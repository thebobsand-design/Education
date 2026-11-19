// Turns the game cards into a list of sites the proxy may reach.
// Pure functions, so they can be checked without the server.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Accepts "cdn.example.com", "*.example.com", ".example.com" or a full link.
// Returns a lowercase hostname with at least one dot, or null.
export function normalizeDomain(input) {
	if (typeof input !== "string") return null;
	let s = input.trim().toLowerCase();
	if (!s) return null;
	if (s.includes("://")) {
		try {
			s = new URL(s).hostname;
		} catch {
			return null;
		}
	}
	s = s.replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "");
	if (s.length > 100) return null;
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
	return s;
}

// Every card allows its own site (without a leading "www.") plus anything in its
// optional "allow" list. Each allowed name also covers all of its subdomains.
export function allowedDomains(games) {
	const out = new Set();
	for (const game of Array.isArray(games) ? games : []) {
		try {
			const host = normalizeDomain(new URL(game.url).hostname);
			if (host) {
				const bare = host.replace(/^www\./, "");
				out.add(bare.includes(".") ? bare : host);
			}
		} catch {
			/* skip a card with a bad address */
		}
		for (const extra of Array.isArray(game.allow) ? game.allow : []) {
			const domain = normalizeDomain(extra);
			if (domain) out.add(domain);
		}
	}
	return [...out].sort();
}

// The Wisp server only offers a blacklist, so the allowlist is written as a
// blacklist entry that matches every host that is NOT allowed.
// An empty list matches everything (blocks all).
export function buildDenyRegex(domains) {
	if (!domains.length) return /^/;
	const alternatives = domains.map(escapeRe).join("|");
	return new RegExp("^(?!(?:[^.]+\\.)*(?:" + alternatives + ")\\.?(?::\\d+)?$)", "i");
}

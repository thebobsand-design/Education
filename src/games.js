import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { normalizeDomain } from "./allowlist.js";

// Environment (set on Render):
//   ADMIN_KEY     the key that unlocks the add-game controls (required for admin)
//   GITHUB_TOKEN  classic token with only the "gist" scope   (permanent storage)
//   GIST_ID       id of a gist containing a file named games.json holding []

export const LIMITS = { name: 40, note: 80, url: 2048, raw: 4000, games: 200, allow: 10 };

const GIST_FILE = "games.json";
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 10;

const digest = (value) => crypto.createHash("sha256").update(String(value)).digest();

// Constant-time comparison; empty or non-string keys never match.
export function keysMatch(given, expected) {
	if (typeof given !== "string" || typeof expected !== "string") return false;
	if (given === "" || expected === "") return false;
	return crypto.timingSafeEqual(digest(given), digest(expected));
}

// Takes a plain link or embed/iframe code and returns an http(s) address, or null.
export function extractUrl(raw) {
	if (typeof raw !== "string") return null;
	const text = raw.trim();
	if (!text || text.length > LIMITS.raw) return null;
	let candidate = text;
	if (text.startsWith("<")) {
		const match = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(text);
		if (!match) return null;
		candidate = (match[1] ?? match[2] ?? "").trim();
	}
	candidate = candidate.replace(/&amp;/g, "&");
	if (candidate.length > LIMITS.url) return null;
	try {
		const url = new URL(candidate);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url.href;
	} catch {
		return null;
	}
}

// Extra sites a card may also reach (CDNs and the like). Comma or space separated.
function parseAllow(raw) {
	if (raw === undefined || raw === null || raw === "") return { ok: true, value: [] };
	const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : null;
	if (!parts) return { ok: false };
	const out = [];
	for (const part of parts) {
		if (typeof part !== "string" || !part.trim()) continue;
		const domain = normalizeDomain(part);
		if (!domain) return { ok: false };
		if (!out.includes(domain)) out.push(domain);
	}
	if (out.length > LIMITS.allow) return { ok: false };
	return { ok: true, value: out };
}

export function sanitizeEntry(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, error: "Send a name and a link." };
	}
	if (typeof input.name !== "string") return { ok: false, error: "Give it a name." };
	const name = input.name.trim();
	if (!name) return { ok: false, error: "Give it a name." };
	if (name.length > LIMITS.name) return { ok: false, error: "That name is too long." };

	let note = "";
	if (input.note !== undefined && input.note !== null) {
		if (typeof input.note !== "string") return { ok: false, error: "That note is not valid." };
		note = input.note.trim();
		if (note.length > LIMITS.note) return { ok: false, error: "That note is too long." };
	}

	const url = extractUrl(input.url);
	if (!url) return { ok: false, error: "Paste a link, or embed code that contains one." };
	const allow = parseAllow(input.allow);
	if (!allow.ok) return { ok: false, error: "Those extra sites are not valid addresses." };
	const value = { name, note, url };
	if (allow.value.length) value.allow = allow.value;
	return { ok: true, value };
}

export function normalizeList(list) {
	if (!Array.isArray(list)) return [];
	const out = [];
	for (const item of list) {
		if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id) continue;
		const clean = sanitizeEntry(item);
		if (clean.ok) out.push({ id: item.id, ...clean.value });
	}
	return out;
}

// ---- stores: { read(): Promise<list>, write(list): Promise<void> } ----

export function createGistStore({ token, gistId, fetchImpl = fetch }) {
	const url = "https://api.github.com/gists/" + encodeURIComponent(gistId);
	const headers = {
		Authorization: "Bearer " + token,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "game-launcher",
	};
	return {
		kind: "gist",
		async read() {
			const res = await fetchImpl(url, { method: "GET", headers });
			if (!res.ok) throw new Error("gist read failed: " + res.status);
			const data = await res.json();
			const file = data.files && data.files[GIST_FILE];
			if (!file || typeof file.content !== "string") throw new Error(GIST_FILE + " missing");
			return normalizeList(JSON.parse(file.content));
		},
		async write(list) {
			const res = await fetchImpl(url, {
				method: "PATCH",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(list, null, 2) } } }),
			});
			if (!res.ok) throw new Error("gist write failed: " + res.status);
		},
	};
}

export function createFileStore(path) {
	return {
		kind: "file",
		async read() {
			try {
				return normalizeList(JSON.parse(await fs.readFile(path, "utf8")));
			} catch (err) {
				if (err && err.code === "ENOENT") return [];
				throw err;
			}
		},
		async write(list) {
			const tmp = path + ".tmp";
			await fs.writeFile(tmp, JSON.stringify(list, null, 2));
			await fs.rename(tmp, path);
		},
	};
}

export function createStoreFromEnv(env, filePath) {
	if (env.GITHUB_TOKEN && env.GIST_ID) {
		return createGistStore({ token: env.GITHUB_TOKEN, gistId: env.GIST_ID });
	}
	return createFileStore(filePath);
}

// ---- the API: every method resolves to { status, body } ----

export function createGamesApi({ store, adminKey = "", newId = () => crypto.randomUUID(), now = Date.now }) {
	let failures = [];
	let chain = Promise.resolve();

	const serial = (task) => {
		const run = chain.then(task, task);
		chain = run.catch(() => {});
		return run;
	};

	// Returns null when the key is accepted, otherwise the response to send.
	function authorize(key) {
		if (!adminKey) return { status: 503, body: { error: "Admin is not set up on the server." } };
		const t = now();
		failures = failures.filter((f) => t - f < FAIL_WINDOW_MS);
		if (failures.length >= FAIL_LIMIT) {
			return { status: 429, body: { error: "Too many attempts. Try again later." } };
		}
		if (!keysMatch(key, adminKey)) {
			failures.push(t);
			return { status: 401, body: { error: "Wrong key." } };
		}
		return null;
	}

	const storeError = { status: 502, body: { error: "Storage is unavailable right now." } };

	return {
		authorize,

		async list() {
			try {
				return { status: 200, body: { games: await store.read() } };
			} catch {
				return storeError;
			}
		},

		async check(key) {
			return authorize(key) || { status: 200, body: { ok: true } };
		},

		async add(key, entry) {
			const denied = authorize(key);
			if (denied) return denied;
			const clean = sanitizeEntry(entry);
			if (!clean.ok) return { status: 400, body: { error: clean.error } };
			try {
				return await serial(async () => {
					const list = await store.read();
					if (list.length >= LIMITS.games) {
						return { status: 400, body: { error: "The list is full." } };
					}
					const game = { id: newId(), ...clean.value };
					await store.write([...list, game]);
					return { status: 201, body: { game } };
				});
			} catch {
				return storeError;
			}
		},

		async update(key, id, entry) {
			const denied = authorize(key);
			if (denied) return denied;
			const clean = sanitizeEntry(entry);
			if (!clean.ok) return { status: 400, body: { error: clean.error } };
			try {
				return await serial(async () => {
					const list = await store.read();
					const at = list.findIndex((g) => g.id === id);
					if (at < 0) return { status: 404, body: { error: "Not found." } };
					const game = { id, ...clean.value };
					const next = list.slice();
					next[at] = game;
					await store.write(next);
					return { status: 200, body: { game } };
				});
			} catch {
				return storeError;
			}
		},

		async remove(key, id) {
			const denied = authorize(key);
			if (denied) return denied;
			try {
				return await serial(async () => {
					const list = await store.read();
					const next = list.filter((g) => g.id !== id);
					if (next.length === list.length) return { status: 404, body: { error: "Not found." } };
					await store.write(next);
					return { status: 200, body: { ok: true } };
				});
			} catch {
				return storeError;
			}
		},
	};
}

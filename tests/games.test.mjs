import test from "node:test";
import assert from "node:assert/strict";
import {
	sanitizeEntry, keysMatch, normalizeList, createGamesApi, createGistStore, LIMITS,
} from "../src/games.js";

function memStore(initial = []) {
	let data = initial;
	return { kind: "mem", writes: 0, async read() { return structuredClone(data); }, async write(l) { this.writes++; data = structuredClone(l); } };
}
let n = 0;
const mk = (extra = {}) => createGamesApi({ store: memStore(), adminKey: "secret-key", newId: () => `id${++n}`, ...extra });

test("sanitizeEntry accepts good input and normalises url", () => {
	const r = sanitizeEntry({ name: " Chess ", url: "https://www.chess.com", note: "" });
	assert.equal(r.ok, true);
	assert.deepEqual(r.value, { name: "Chess", note: "", url: "https://www.chess.com/" });
});
test("sanitizeEntry rejects bad input", () => {
	for (const bad of [null, [], {}, { name: "", url: "https://a.b" }, { name: "x", url: "javascript:alert(1)" },
		{ name: "x", url: "ftp://a.b" }, { name: "x", url: "nope" }, { name: "x".repeat(LIMITS.name + 1), url: "https://a.b" },
		{ name: "x", url: "https://a.b", note: "n".repeat(LIMITS.note + 1) }, { name: 5, url: "https://a.b" }]) {
		assert.equal(sanitizeEntry(bad).ok, false, JSON.stringify(bad));
	}
});
test("keysMatch", () => {
	assert.equal(keysMatch("a", "a"), true);
	assert.equal(keysMatch("a", "b"), false);
	assert.equal(keysMatch("", ""), false);
	assert.equal(keysMatch(undefined, "a"), false);
	assert.equal(keysMatch("a", ""), false);
});
test("normalizeList drops invalid and id-less entries", () => {
	const out = normalizeList([{ id: "1", name: "A", url: "https://a.b" }, { name: "noid", url: "https://a.b" }, { id: "2", name: "", url: "https://a.b" }, "x"]);
	assert.equal(out.length, 1);
	assert.equal(normalizeList("nope").length, 0);
});
test("add / list / remove flow", async () => {
	const api = mk();
	assert.equal((await api.add("secret-key", { name: "A", url: "https://a.example" })).status, 201);
	assert.equal((await api.add("secret-key", { name: "B", url: "https://b.example" })).status, 201);
	let list = (await api.list()).body.games;
	assert.equal(list.length, 2);
	const id = list[0].id;
	assert.equal((await api.remove("secret-key", id)).status, 200);
	assert.equal((await api.remove("secret-key", id)).status, 404);
	list = (await api.list()).body.games;
	assert.equal(list.length, 1);
});
test("wrong or missing key is refused and writes nothing", async () => {
	const store = memStore();
	const api = createGamesApi({ store, adminKey: "secret-key" });
	assert.equal((await api.add("nope", { name: "A", url: "https://a.example" })).status, 401);
	assert.equal((await api.add(undefined, { name: "A", url: "https://a.example" })).status, 401);
	assert.equal((await api.remove("nope", "x")).status, 401);
	assert.equal(store.writes, 0);
});
test("no admin key configured => 503", async () => {
	const api = createGamesApi({ store: memStore(), adminKey: "" });
	assert.equal((await api.check("anything")).status, 503);
	assert.equal((await api.add("", { name: "A", url: "https://a.example" })).status, 503);
});
test("lockout after repeated wrong keys, expires after window", async () => {
	let t = 1_000_000;
	const api = createGamesApi({ store: memStore(), adminKey: "secret-key", now: () => t });
	for (let i = 0; i < 10; i++) assert.equal((await api.check("bad")).status, 401);
	assert.equal((await api.check("secret-key")).status, 429);
	t += 16 * 60 * 1000;
	assert.equal((await api.check("secret-key")).status, 200);
});
test("bad entry => 400 and nothing written", async () => {
	const store = memStore();
	const api = createGamesApi({ store, adminKey: "k" });
	assert.equal((await api.add("k", { name: "A", url: "javascript:1" })).status, 400);
	assert.equal(store.writes, 0);
});
test("game limit enforced", async () => {
	const seed = Array.from({ length: LIMITS.games }, (_, i) => ({ id: `s${i}`, name: `G${i}`, url: "https://a.example/" }));
	const api = createGamesApi({ store: memStore(seed), adminKey: "k" });
	assert.equal((await api.add("k", { name: "X", url: "https://x.example" })).status, 400);
});
test("concurrent adds are not lost", async () => {
	const api = mk();
	await Promise.all(["a", "b", "c", "d"].map((x) => api.add("secret-key", { name: x, url: `https://${x}.example` })));
	assert.equal((await api.list()).body.games.length, 4);
});
test("store failure => 502, not a crash", async () => {
	const store = { async read() { throw new Error("boom"); }, async write() {} };
	const api = createGamesApi({ store, adminKey: "k" });
	assert.equal((await api.list()).status, 502);
	assert.equal((await api.add("k", { name: "A", url: "https://a.example" })).status, 502);
});
test("gist store reads and writes via the GitHub gist API shape", async () => {
	const calls = [];
	let content = JSON.stringify([{ id: "1", name: "A", url: "https://a.example/" }]);
	const fetchImpl = async (url, opts = {}) => {
		calls.push({ url, method: opts.method || "GET", auth: opts.headers.Authorization });
		if (opts.method === "PATCH") { content = JSON.parse(opts.body).files["games.json"].content; return { ok: true, status: 200 }; }
		return { ok: true, status: 200, json: async () => ({ files: { "games.json": { content } } }) };
	};
	const store = createGistStore({ token: "T", gistId: "G1", fetchImpl });
	assert.equal((await store.read()).length, 1);
	await store.write([]);
	assert.equal(content, "[]");
	assert.equal(calls[0].url, "https://api.github.com/gists/G1");
	assert.equal(calls[1].method, "PATCH");
	assert.equal(calls[0].auth, "Bearer T");
});

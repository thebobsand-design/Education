import test from "node:test";
import assert from "node:assert/strict";
import { createGamesApi } from "../src/games.js";
import { createData } from "../src/data.js";
import { createApi, checkImage } from "../src/api.js";

function memoryPersist(initial = {}) {
	const files = { ...initial };
	return {
		files,
		async loadAll() { return { ...files }; },
		async writeFiles(changes) {
			for (const [n, c] of Object.entries(changes)) { if (c === null) delete files[n]; else files[n] = c; }
		},
	};
}
function setup(initial) {
	const persist = memoryPersist(initial);
	const data = createData({ persist, flushMs: 5 });
	const games = createGamesApi({ store: data.gamesStore, adminKey: "secret" });
	let n = 0;
	const api = createApi({ games, data, newId: () => "id" + ++n });
	return { api, persist, data };
}
const A = "a".repeat(16), B = "b".repeat(16);
const IMG = "data:image/jpeg;base64,AAAA";

test("image check", () => {
	assert.equal(checkImage(undefined).value, undefined);
	assert.equal(checkImage(null).value, null);
	assert.equal(checkImage(IMG).ok, true);
	assert.equal(checkImage("data:image/png;base64,AAAA").ok, false);
	assert.equal(checkImage("data:image/jpeg;base64,<x>").ok, false);
	assert.equal(checkImage(IMG + "A".repeat(70000)).status, 413);
});

test("games: add with picture, edit, remove", async () => {
	const { api, persist } = setup();
	const add = await api.gameAdd("secret", { name: "Snake", url: "https://a.com/", image: IMG }, A);
	assert.equal(add.status, 201);
	assert.equal(add.body.game.image, IMG);
	const id = add.body.game.id;
	assert.equal(persist.files[`img-${id}.txt`], IMG);
	assert.equal(JSON.parse(persist.files["games.json"])[0].image, undefined);
	assert.equal((await api.gamesList(A)).body.games[0].image, IMG);
	let upd = await api.gameUpdate("secret", id, { name: "Snake 2", url: "https://a.com/" });
	assert.equal(upd.body.game.image, IMG); // untouched when omitted
	upd = await api.gameUpdate("secret", id, { name: "Snake 2", url: "https://a.com/", image: null });
	assert.equal(upd.body.game.image, undefined);
	assert.equal(persist.files[`img-${id}.txt`], undefined);
	assert.equal((await api.gameUpdate("nope", id, {})).status, 401);
	assert.equal((await api.gameRemove("secret", id)).status, 200);
	assert.equal((await api.gameUpdate("secret", id, { name: "x", url: "https://a.com/" })).status, 404);
});

test("polls: create, vote once, close, counts", async () => {
	const { api } = setup();
	const made = await api.createPoll("secret", { question: "Best?", options: ["Snake", "Tetris"] });
	assert.equal(made.status, 201);
	const pid = made.body.poll.id;
	assert.equal((await api.createPoll("secret", { question: "q", options: ["one"] })).status, 400);
	const v = await api.vote(A, pid, { optionId: "o2" });
	assert.equal(v.status, 200);
	assert.equal(v.body.poll.options[1].votes, 1);
	const again = await api.vote(A, pid, { optionId: "o1" });
	assert.equal(again.status, 409);
	assert.equal(again.body.voted, "o2");
	assert.equal((await api.vote(B, pid, { optionId: "zzz" })).status, 400);
	await api.setPollClosed("secret", pid, { closed: true });
	assert.equal((await api.vote(B, pid, { optionId: "o1" })).status, 409);
	const me = await api.me(A);
	assert.equal(me.body.polls[0].voted, "o2");
	assert.equal(me.body.polls[0].closed, true);
});

test("messages: all vs one device, warnings need a device, seen", async () => {
	const { api } = setup();
	assert.equal((await api.sendMessage("secret", { type: "warning", to: "all", text: "x" })).status, 400);
	await api.sendMessage("secret", { type: "announcement", to: "all", text: "hello" });
	const w = await api.sendMessage("secret", { type: "warning", to: A, text: "stop" });
	assert.equal((await api.me(A)).body.messages.length, 2);
	assert.equal((await api.me(B)).body.messages.length, 1);
	await api.seen(A, { ids: [w.body.message.id] });
	assert.equal((await api.me(A)).body.messages.length, 1);
	const list = await api.listMessages("secret");
	assert.equal(list.body.messages.find((m) => m.id === w.body.message.id).seenCount, 1);
	assert.equal((await api.deleteMessage("secret", w.body.message.id)).status, 200);
});

test("requests, reports, inbox", async () => {
	const { api } = setup();
	const g = await api.gameAdd("secret", { name: "Snake", url: "https://a.com/" }, A);
	assert.equal((await api.addRequest(A, { name: "Tetris", link: "https://t.com", note: "pls" })).status, 201);
	assert.equal((await api.addRequest(A, {})).status, 400);
	assert.equal((await api.addReport(A, { gameId: "missing", reason: "Other" })).status, 404);
	assert.equal((await api.addReport(A, { gameId: g.body.game.id, reason: "Won't load" })).status, 201);
	const box = await api.inbox("secret");
	assert.equal(box.body.requests[0].deviceId, A);
	assert.equal(box.body.reports[0].gameName, "Snake");
	assert.equal((await api.inbox("bad")).status, 401);
	assert.equal((await api.deleteRequest("secret", box.body.requests[0].id)).status, 200);
	assert.equal((await api.deleteReport("secret", "nope")).status, 404);
	await api.gameRemove("secret", g.body.game.id);
	assert.equal((await api.inbox("secret")).body.reports.length, 0);
});

test("bans block everything and show in users", async () => {
	const { api } = setup();
	await api.me(A);
	assert.equal((await api.ban("secret", { deviceId: "short", reason: "x" })).status, 400);
	assert.equal((await api.ban("secret", { deviceId: A, reason: "spam" })).status, 200);
	assert.equal(api.isBanned(A), true);
	const me = await api.me(A);
	assert.equal(me.status, 403);
	assert.deepEqual(me.body, { banned: true, reason: "spam" });
	assert.equal((await api.gamesList(A)).status, 403);
	assert.equal((await api.addRequest(A, { name: "x" })).status, 403);
	const users = (await api.users("secret")).body.users;
	assert.equal(users.find((u) => u.id === A).banned, true);
	assert.equal((await api.unban("secret", A)).status, 200);
	assert.equal((await api.me(A)).status, 200);
	assert.equal((await api.unban("secret", A)).status, 404);
});

test("state survives a restart and bad json fails closed", async () => {
	const s1 = setup();
	await s1.api.ban("secret", { deviceId: A, reason: "r" });
	const s2 = setup({ ...s1.persist.files });
	assert.equal((await s2.api.me(A)).status, 403);
	const s3 = setup({ "state.json": "{oops" });
	assert.equal((await s3.api.me(A)).status, 502);
});

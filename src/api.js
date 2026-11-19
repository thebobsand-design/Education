import crypto from "node:crypto";
import { LIMITS } from "./games.js";

// Everything the launcher's other features need: pictures on cards, devices,
// bans, polls, announcements and warnings, game requests and reports.
// Every method resolves to { status, body }.

export const API_LIMITS = {
	image: 70000,
	question: 140,
	option: 60,
	options: 6,
	polls: 20,
	message: 400,
	messages: 200,
	reason: 200,
	requests: 200,
	reports: 200,
	perDevice: 10, // open requests/reports one device may have waiting
	details: 400,
	link: 2048,
};

export const DEVICE_ID = /^[a-f0-9]{16,64}$/;
const IMAGE_PREFIX = "data:image/jpeg;base64,";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const bad = (error, status = 400) => ({ status, body: { error } });
const ok = (body = { ok: true }, status = 200) => ({ status, body });

export function cleanDeviceId(value) {
	return typeof value === "string" && DEVICE_ID.test(value) ? value : null;
}

// Returns { ok, value } where value is a data URL, null (remove) or undefined (leave alone).
export function checkImage(input) {
	if (input === undefined) return { ok: true, value: undefined };
	if (input === null || input === "") return { ok: true, value: null };
	if (typeof input !== "string") return { ok: false, status: 400, error: "That picture is not valid." };
	if (input.length > API_LIMITS.image) {
		return { ok: false, status: 413, error: "That picture is too big." };
	}
	if (!input.startsWith(IMAGE_PREFIX) || !BASE64.test(input.slice(IMAGE_PREFIX.length))) {
		return { ok: false, status: 400, error: "That picture is not valid." };
	}
	return { ok: true, value: input };
}

export function createApi({ games, data, newId = () => crypto.randomBytes(6).toString("hex"), now = () => new Date() }) {
	const stamp = () => now().toISOString();
	const state = () => data.state;
	const storageDown = bad("Storage is unavailable right now.", 502);

	async function ready() {
		try {
			await data.load();
			return null;
		} catch {
			return storageDown;
		}
	}

	function banOf(id) {
		return id ? state().bans[id] || null : null;
	}
	const bannedReply = (ban) => ({ status: 403, body: { banned: true, reason: ban.reason || "" } });

	// Every non-admin call runs through this: loads data, refuses banned devices,
	// and records that the device was here.
	async function enter(deviceId, { track = true } = {}) {
		const down = await ready();
		if (down) return { reply: down };
		const id = cleanDeviceId(deviceId);
		const ban = banOf(id);
		if (ban) return { reply: bannedReply(ban) };
		if (id && track) {
			const users = state().users;
			const at = stamp();
			if (users[id]) users[id].lastSeen = at;
			else {
				users[id] = { firstSeen: at, lastSeen: at };
				data.trimUsers();
			}
			data.saveState();
		}
		return { id };
	}

	// Admin calls: the key is checked first, then data is loaded.
	async function admin(key) {
		const denied = games.authorize(key);
		if (denied) return { reply: denied };
		const down = await ready();
		if (down) return { reply: down };
		return {};
	}

	async function persist() {
		try {
			await data.saveState(true);
			return null;
		} catch {
			return storageDown;
		}
	}

	const withImage = (game) => {
		const image = data.images.get(game.id);
		return image ? { ...game, image } : game;
	};

	function publicPoll(poll, id) {
		const voted = id ? poll.votes[id] : undefined;
		const counts = {};
		for (const optionId of Object.values(poll.votes)) counts[optionId] = (counts[optionId] || 0) + 1;
		const out = {
			id: poll.id,
			question: poll.question,
			closed: Boolean(poll.closed),
			options: poll.options.map((o) => ({ id: o.id, text: o.text, votes: counts[o.id] || 0 })),
		};
		if (voted !== undefined) out.voted = voted;
		return out;
	}

	return {
		// ---------- games (with pictures) ----------
		async gamesList(deviceId) {
			const e = await enter(deviceId, { track: false });
			if (e.reply) return e.reply;
			const res = await games.list();
			if (res.status !== 200) return res;
			return ok({ games: res.body.games.map(withImage) });
		},

		async gameAdd(key, body, deviceId) {
			const denied = games.authorize(key);
			if (denied) return denied;
			const img = checkImage(body && body.image);
			if (!img.ok) return bad(img.error, img.status);
			const down = await ready();
			if (down) return down;
			const res = await games.add(key, body);
			if (res.status !== 201) return res;
			if (img.value) {
				data.images.set(res.body.game.id, img.value);
				try {
					await data.flush();
				} catch {
					return storageDown;
				}
			}
			return { status: 201, body: { game: withImage(res.body.game) } };
		},

		async gameUpdate(key, id, body) {
			const denied = games.authorize(key);
			if (denied) return denied;
			const img = checkImage(body && body.image);
			if (!img.ok) return bad(img.error, img.status);
			const down = await ready();
			if (down) return down;
			const res = await games.update(key, id, body);
			if (res.status !== 200) return res;
			if (img.value) data.images.set(id, img.value);
			else if (img.value === null) data.images.remove(id);
			if (img.value !== undefined) {
				try {
					await data.flush();
				} catch {
					return storageDown;
				}
			}
			return { status: 200, body: { game: withImage(res.body.game) } };
		},

		async gameRemove(key, id) {
			const res = await games.remove(key, id);
			if (res.status !== 200) return res;
			data.images.remove(id);
			const s = state();
			s.reports = s.reports.filter((r) => r.gameId !== id);
			data.saveState();
			try {
				await data.flush();
			} catch {
				return storageDown;
			}
			return res;
		},

		// ---------- the visitor ----------
		async me(deviceId) {
			const e = await enter(deviceId);
			if (e.reply) return e.reply;
			const s = state();
			const polls = s.polls.map((p) => publicPoll(p, e.id));
			const messages = e.id
				? s.messages
						.filter((m) => (m.to === "all" || m.to === e.id) && !(m.seen || []).includes(e.id))
						.map((m) => ({ id: m.id, type: m.type, text: m.text, at: m.at }))
				: [];
			return ok({ banned: false, polls, messages });
		},

		async seen(deviceId, body) {
			const e = await enter(deviceId);
			if (e.reply) return e.reply;
			if (!e.id) return bad("Missing device.");
			const ids = Array.isArray(body && body.ids) ? body.ids.map(String).slice(0, 50) : [];
			let changed = false;
			for (const m of state().messages) {
				if (!ids.includes(m.id) || (m.to !== "all" && m.to !== e.id)) continue;
				m.seen = m.seen || [];
				if (!m.seen.includes(e.id)) {
					m.seen.push(e.id);
					changed = true;
				}
			}
			if (changed) data.saveState();
			return ok();
		},

		async vote(deviceId, pollId, body) {
			const e = await enter(deviceId);
			if (e.reply) return e.reply;
			if (!e.id) return bad("Missing device.");
			const poll = state().polls.find((p) => p.id === pollId);
			if (!poll) return bad("Not found.", 404);
			if (poll.votes[e.id] !== undefined) {
				return { status: 409, body: { error: "Already voted.", voted: poll.votes[e.id] } };
			}
			if (poll.closed) return bad("That poll is closed.", 409);
			const optionId = body && body.optionId;
			const option = poll.options.find((o) => o.id === String(optionId));
			if (!option) return bad("Pick one of the choices.");
			poll.votes[e.id] = option.id;
			const down = await persist();
			if (down) {
				delete poll.votes[e.id];
				return down;
			}
			return ok({ ok: true, poll: publicPoll(poll, e.id) });
		},

		async addRequest(deviceId, body) {
			const e = await enter(deviceId);
			if (e.reply) return e.reply;
			if (!e.id) return bad("Missing device.");
			const name = clip(body && body.name, LIMITS.name);
			const link = clip(body && body.link, API_LIMITS.link);
			const note = clip(body && body.note, API_LIMITS.details);
			if (!name && !link) return bad("Tell us the name or send a link.");
			const s = state();
			if (s.requests.length >= API_LIMITS.requests) return bad("Too many requests waiting. Try later.", 429);
			if (s.requests.filter((r) => r.deviceId === e.id).length >= API_LIMITS.perDevice) {
				return bad("You have a lot waiting already. Try again later.", 429);
			}
			const item = { id: newId(), name, link, note, deviceId: e.id, at: stamp() };
			s.requests.push(item);
			const down = await persist();
			if (down) {
				s.requests.pop();
				return down;
			}
			return ok({ ok: true }, 201);
		},

		async addReport(deviceId, body) {
			const e = await enter(deviceId);
			if (e.reply) return e.reply;
			if (!e.id) return bad("Missing device.");
			const gameId = clip(body && body.gameId, 100);
			const reason = clip(body && body.reason, 60) || "Other";
			const details = clip(body && body.details, API_LIMITS.details);
			const list = await games.list();
			if (list.status !== 200) return list;
			const game = list.body.games.find((g) => g.id === gameId);
			if (!game) return bad("Not found.", 404);
			const s = state();
			if (s.reports.length >= API_LIMITS.reports) return bad("Too many reports waiting. Try later.", 429);
			if (s.reports.filter((r) => r.deviceId === e.id).length >= API_LIMITS.perDevice) {
				return bad("You have a lot waiting already. Try again later.", 429);
			}
			const item = { id: newId(), gameId, gameName: game.name, reason, details, deviceId: e.id, at: stamp() };
			s.reports.push(item);
			const down = await persist();
			if (down) {
				s.reports.pop();
				return down;
			}
			return ok({ ok: true }, 201);
		},

		// ---------- admin: inbox ----------
		async inbox(key) {
			const a = await admin(key);
			if (a.reply) return a.reply;
			const s = state();
			return ok({ requests: s.requests, reports: s.reports });
		},

		async deleteRequest(key, id) {
			return removeFrom(key, "requests", id);
		},
		async deleteReport(key, id) {
			return removeFrom(key, "reports", id);
		},

		// ---------- admin: polls ----------
		async createPoll(key, body) {
			const a = await admin(key);
			if (a.reply) return a.reply;
			const question = clip(body && body.question, API_LIMITS.question);
			if (!question) return bad("Write the question.");
			const raw = Array.isArray(body && body.options) ? body.options : [];
			const texts = raw.map((o) => clip(o, API_LIMITS.option)).filter(Boolean);
			if (texts.length < 2) return bad("Give at least two choices.");
			if (texts.length > API_LIMITS.options) return bad("That is too many choices.");
			const s = state();
			if (s.polls.length >= API_LIMITS.polls) return bad("Too many polls. Delete an old one.");
			const poll = {
				id: newId(),
				question,
				options: texts.map((text, i) => ({ id: "o" + (i + 1), text })),
				closed: false,
				votes: {},
				at: stamp(),
			};
			s.polls.push(poll);
			const down = await persist();
			if (down) {
				s.polls.pop();
				return down;
			}
			return ok({ poll: { ...publicPoll(poll), at: poll.at } }, 201);
		},

		async listPolls(key) {
			const a = await admin(key);
			if (a.reply) return a.reply;
			return ok({ polls: state().polls.map((p) => ({ ...publicPoll(p), at: p.at })) });
		},

		async setPollClosed(key, id, body) {
			const a = await admin(key);
			if (a.reply) return a.reply;
			const poll = state().polls.find((p) => p.id === id);
			if (!poll) return bad("Not found.", 404);
			const before = poll.closed;
			poll.closed = Boolean(body && body.closed);
			const down = await persist();
			if (down) {
				poll.closed = before;
				return down;
			}
			return ok({ poll: { ...publicPoll(poll), at: poll.at } });
		},

		async deletePoll(key, id) {
			return removeFrom(key, "polls", id);
		},

		// ---------- admin: messages ----------
		async sendMessage(key, body) {
			const a = await admin(key);
			if (a.reply) return a.reply;
			const type = body && body.type === "warning" ? "warning" : body && body.type === "announcement" ? "announcement" : null;
			if (!type) return bad("Pick announcement or warning.");
			const text = clip(body.text, API_LIMITS.message);
			if (!text) return bad("Write the message.");
			let to = body.to;
			if (to !== "all") {
				to = cleanDeviceId(to);
				if (!to) return bad("Pick who it is for.");
			}
			if (type === "warning" && to === "all") return bad("Warnings go to one device.");
			const s = state();
			if (s.messages.length >= API_LIMITS.messages) return bad("Too many messages. Delete some old ones.");
			const message = { id: newId(), type, text, to, at: stamp(), seen: [] };
			s.messages.push(message);
			const down = await persist();
			if (down) {
				s.messages.pop();
				return down;
			}
			return ok({ message: { id: message.id, type, text, to, at: message.at, seenCount: 0 } }, 201);
		},

		async listMessages(key) {
			const a = await admin(key);
			if (a.reply) return a.reply;
			return ok({
				messages: state().messages.map((m) => ({
					id: m.id,
					type: m.type,
					text: m.text,
					to: m.to,
					at: m.at,
					seenCount: (m.seen || []).length,
				})),
			});
		},

		async deleteMessage(key, id) {
			return removeFrom(key, "messages", id);
		},

		// ---------- admin: devices and bans ----------
		async users(key) {
			const a = await admin(key);
			if (a.reply) return a.reply;
			const s = state();
			const ids = new Set([...Object.keys(s.users), ...Object.keys(s.bans)]);
			const users = [...ids].map((id) => {
				const u = s.users[id] || {};
				const ban = s.bans[id];
				const row = { id, banned: Boolean(ban), lastSeen: u.lastSeen || null, firstSeen: u.firstSeen || null };
				if (ban) row.reason = ban.reason || "";
				return row;
			});
			return ok({ users });
		},

		async ban(key, body) {
			const a = await admin(key);
			if (a.reply) return a.reply;
			const id = cleanDeviceId(body && body.deviceId);
			if (!id) return bad("That is not a device ID.");
			const s = state();
			const before = s.bans[id];
			s.bans[id] = { reason: clip(body.reason, API_LIMITS.reason), at: stamp() };
			const down = await persist();
			if (down) {
				if (before) s.bans[id] = before;
				else delete s.bans[id];
				return down;
			}
			return ok();
		},

		async unban(key, id) {
			const a = await admin(key);
			if (a.reply) return a.reply;
			const s = state();
			const before = s.bans[id];
			if (!before) return bad("Not found.", 404);
			delete s.bans[id];
			const down = await persist();
			if (down) {
				s.bans[id] = before;
				return down;
			}
			return ok();
		},

		// Used by the wisp upgrade, so it must be quick and never throw.
		isBanned(deviceId) {
			const id = cleanDeviceId(deviceId);
			return Boolean(id && data.state.bans[id]);
		},
	};

	async function removeFrom(key, listName, id) {
		const a = await admin(key);
		if (a.reply) return a.reply;
		const s = state();
		const at = s[listName].findIndex((item) => item.id === id);
		if (at < 0) return bad("Not found.", 404);
		const [removed] = s[listName].splice(at, 1);
		const down = await persist();
		if (down) {
			s[listName].splice(at, 0, removed);
			return down;
		}
		return ok();
	}
}

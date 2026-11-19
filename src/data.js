import { normalizeList } from "./games.js";

// Everything the site remembers lives here, in memory, and is saved to the
// persistence layer (see persist.js). Loaded once, on first use.
//   games.json     the card list
//   state.json     requests, reports, polls, messages, devices, bans
//   img-<id>.txt   one cover picture per game (a data: URL)

const GAMES_FILE = "games.json";
const STATE_FILE = "state.json";
const IMG_PREFIX = "img-";
const IMG_SUFFIX = ".txt";
const MAX_USERS = 5000;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const objectsIn = (v) => (Array.isArray(v) ? v.filter(isObject) : []);

function parseJson(raw, what) {
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		// Fail closed: starting empty would overwrite the real file on the next save.
		throw new Error(what + " is not valid JSON");
	}
}

export function emptyState() {
	return { requests: [], reports: [], polls: [], messages: [], users: {}, bans: {} };
}

export function normalizeState(raw) {
	const parsed = parseJson(raw, STATE_FILE);
	if (!isObject(parsed)) return emptyState();
	return {
		requests: objectsIn(parsed.requests),
		reports: objectsIn(parsed.reports),
		polls: objectsIn(parsed.polls),
		messages: objectsIn(parsed.messages),
		users: isObject(parsed.users) ? parsed.users : {},
		bans: isObject(parsed.bans) ? parsed.bans : {},
	};
}

const imageName = (id) => IMG_PREFIX + id + IMG_SUFFIX;

export function createData({ persist, flushMs = 20000 }) {
	let loading = null;
	let games = [];
	let state = emptyState();
	const imageMap = new Map();
	const persisted = new Set();
	let dirty = new Map(); // file name -> content (or null to delete)
	let timer = null;
	let chain = Promise.resolve();

	function load() {
		if (!loading) {
			loading = (async () => {
				const files = await persist.loadAll();
				games = normalizeList(parseJson(files[GAMES_FILE], GAMES_FILE) || []);
				state = normalizeState(files[STATE_FILE]);
				for (const [name, content] of Object.entries(files)) {
					persisted.add(name);
					if (name.startsWith(IMG_PREFIX) && name.endsWith(IMG_SUFFIX)) {
						imageMap.set(name.slice(IMG_PREFIX.length, -IMG_SUFFIX.length), content);
					}
				}
			})().catch((err) => {
				loading = null; // try again on the next request
				throw err;
			});
		}
		return loading;
	}

	function flush() {
		clearTimeout(timer);
		timer = null;
		const batch = Object.fromEntries(dirty);
		if (!Object.keys(batch).length) return chain;
		dirty = new Map();
		const run = chain.then(async () => {
			try {
				await persist.writeFiles(batch);
			} catch (err) {
				for (const [name, content] of Object.entries(batch)) {
					if (!dirty.has(name)) dirty.set(name, content); // keep it for the next try
				}
				throw err;
			}
			for (const [name, content] of Object.entries(batch)) {
				if (content === null) persisted.delete(name);
				else persisted.add(name);
			}
		});
		chain = run.catch(() => {});
		return run;
	}

	function schedule() {
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			flush().catch(() => schedule());
		}, flushMs);
		if (timer.unref) timer.unref();
	}

	const gamesStore = {
		kind: "data",
		async read() {
			await load();
			return structuredClone(games);
		},
		async write(list) {
			await load();
			games = structuredClone(list);
			dirty.set(GAMES_FILE, JSON.stringify(list, null, 2));
			await flush();
		},
	};

	const images = {
		get(id) {
			return imageMap.get(String(id)) || null;
		},
		set(id, dataUrl) {
			imageMap.set(String(id), dataUrl);
			dirty.set(imageName(id), dataUrl);
		},
		remove(id) {
			imageMap.delete(String(id));
			const name = imageName(id);
			if (persisted.has(name)) dirty.set(name, null);
			else dirty.delete(name);
		},
	};

	return {
		load,
		flush,
		gamesStore,
		images,
		get state() {
			return state;
		},
		// Queue state.json for saving. immediate=true waits until it is written.
		saveState(immediate = false) {
			dirty.set(STATE_FILE, JSON.stringify(state));
			if (immediate) return flush();
			schedule();
			return Promise.resolve();
		},
		trimUsers() {
			const ids = Object.keys(state.users);
			if (ids.length <= MAX_USERS) return;
			ids
				.filter((id) => !state.bans[id])
				.sort((a, b) => String(state.users[a].lastSeen).localeCompare(String(state.users[b].lastSeen)))
				.slice(0, ids.length - MAX_USERS)
				.forEach((id) => delete state.users[id]);
		},
	};
}

import { promises as fs } from "node:fs";
import { join } from "node:path";

// A persistence layer is a set of named text files:
//   loadAll():          Promise<{ [name]: string }>
//   writeFiles(changes) Promise<void>   changes is { [name]: string | null }  (null deletes)

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

// Files live in one private GitHub gist (permanent, free).
export function createGistPersist({ token, gistId, fetchImpl = fetch }) {
	const url = "https://api.github.com/gists/" + encodeURIComponent(gistId);
	const headers = {
		Authorization: "Bearer " + token,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "game-launcher",
	};
	return {
		kind: "gist",
		async loadAll() {
			const res = await fetchImpl(url, { method: "GET", headers });
			if (!res.ok) throw new Error("gist read failed: " + res.status);
			const data = await res.json();
			const out = {};
			for (const [name, file] of Object.entries(data.files || {})) {
				if (!file) continue;
				// Refuse to start from half a file: writing back would destroy the rest.
				if (file.truncated || typeof file.content !== "string") {
					throw new Error("gist file too large to read: " + name);
				}
				out[name] = file.content;
			}
			return out;
		},
		async writeFiles(changes) {
			const files = {};
			for (const [name, content] of Object.entries(changes)) {
				files[name] = content === null ? null : { content };
			}
			const res = await fetchImpl(url, {
				method: "PATCH",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ files }),
			});
			if (!res.ok) throw new Error("gist write failed: " + res.status);
		},
	};
}

// Files live in a folder (local testing; wiped on Render's free plan).
export function createFilePersist(dir) {
	return {
		kind: "file",
		async loadAll() {
			await fs.mkdir(dir, { recursive: true });
			const out = {};
			for (const name of await fs.readdir(dir)) {
				if (!SAFE_NAME.test(name) || name.endsWith(".tmp")) continue;
				out[name] = await fs.readFile(join(dir, name), "utf8");
			}
			return out;
		},
		async writeFiles(changes) {
			await fs.mkdir(dir, { recursive: true });
			for (const [name, content] of Object.entries(changes)) {
				if (!SAFE_NAME.test(name)) throw new Error("bad file name: " + name);
				const target = join(dir, name);
				if (content === null) {
					await fs.rm(target, { force: true });
					continue;
				}
				await fs.writeFile(target + ".tmp", content);
				await fs.rename(target + ".tmp", target);
			}
		},
	};
}

export function createPersistFromEnv(env, dir) {
	if (env.GITHUB_TOKEN && env.GIST_ID) {
		return createGistPersist({ token: env.GITHUB_TOKEN, gistId: env.GIST_ID });
	}
	return createFilePersist(dir);
}

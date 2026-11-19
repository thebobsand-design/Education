import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

import { createGamesApi } from "./games.js";
import { createPersistFromEnv } from "./persist.js";
import { createData } from "./data.js";
import { createApi } from "./api.js";
import { allowedDomains, buildDenyRegex } from "./allowlist.js";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

// Launcher game list. Durable on Render only with GITHUB_TOKEN + GIST_ID set;
// otherwise it falls back to a temp file (fine for local testing).
// Everything (cards, pictures, polls, bans...) is saved as files in the same gist.
const data = createData({
	persist: createPersistFromEnv(process.env, process.env.DATA_DIR || join(tmpdir(), "study-hub-data")),
});
const games = createGamesApi({ store: data.gamesStore, adminKey: process.env.ADMIN_KEY || "" });
const api = createApi({ games, data });

function deviceFromCookie(header) {
	const match = /(?:^|;\s*)sh_id=([a-f0-9]{16,64})(?:;|$)/.exec(header || "");
	return match ? match[1] : null;
}

function send(reply, result) {
	return reply.code(result.status).header("Cache-Control", "no-store").send(result.body);
}

// Wisp Configuration: Refer to the documentation at https://www.npmjs.com/package/@mercuryworkshop/wisp-js

logging.set_level(logging.NONE);
Object.assign(wisp.options, {
        allow_udp_streams: false,
        hostname_blacklist: [/example\.com/, /(^|\.)google\.com$/],
        dns_servers: ["1.1.1.3", "1.0.0.3"],
});

// Allowlist: the proxy may only reach the sites on the game cards (and their
// subdomains, plus any "also allow" sites). Set ALLOWLIST=off on Render to switch
// this off. Until the card list has loaded, everything is blocked.
const BASE_BLACKLIST = [...wisp.options.hostname_blacklist];
const ENFORCE_ALLOWLIST = process.env.ALLOWLIST !== "off";

async function syncAllowlist() {
	if (!ENFORCE_ALLOWLIST) return;
	const res = await games.list();
	if (res.status !== 200) return;
	wisp.options.hostname_blacklist = [
		...BASE_BLACKLIST,
		buildDenyRegex(allowedDomains(res.body.games)),
	];
}
if (ENFORCE_ALLOWLIST) wisp.options.hostname_blacklist = [...BASE_BLACKLIST, buildDenyRegex([])];

const fastify = Fastify({
        serverFactory: (handler) => {
                return createServer()
                        .on("request", (req, res) => {
                                res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
                                res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
                                handler(req, res);
                        })
                        .on("upgrade", (req, socket, head) => {
                                if (req.url.endsWith("/wisp/")) {
                                        // Banned devices cannot open the proxy either.
                                        if (api.isBanned(deviceFromCookie(req.headers.cookie))) return socket.end();
                                        wisp.routeRequest(req, socket, head);
                                }
                                else socket.end();
                        });
        },
});

fastify.register(fastifyStatic, {
        root: publicPath,
        decorateReply: true,
});

fastify.register(fastifyStatic, {
        root: scramjetPath,
        prefix: "/scram/",
        decorateReply: false,
});

fastify.register(fastifyStatic, {
        root: libcurlPath,
        prefix: "/libcurl/",
        decorateReply: false,
});

fastify.register(fastifyStatic, {
        root: baremuxPath,
        prefix: "/baremux/",
        decorateReply: false,
});

const key = (req) => req.headers["x-admin-key"];
const device = (req) => req.headers["x-device-id"] || deviceFromCookie(req.headers.cookie);

fastify.get("/api/games", async (req, reply) => send(reply, await api.gamesList(device(req))));
fastify.post("/api/admin/check", async (req, reply) => send(reply, await games.check(key(req))));
fastify.post("/api/games", async (req, reply) => {
	const result = await api.gameAdd(key(req), req.body, device(req));
	if (result.status === 201) await syncAllowlist().catch(() => {});
	return send(reply, result);
});
fastify.patch("/api/games/:id", async (req, reply) => {
	const result = await api.gameUpdate(key(req), req.params.id, req.body);
	if (result.status === 200) await syncAllowlist().catch(() => {});
	return send(reply, result);
});
fastify.delete("/api/games/:id", async (req, reply) => {
	const result = await api.gameRemove(key(req), req.params.id);
	if (result.status === 200) await syncAllowlist().catch(() => {});
	return send(reply, result);
});

fastify.get("/api/me", async (req, reply) => send(reply, await api.me(device(req))));
fastify.post("/api/me/seen", async (req, reply) => send(reply, await api.seen(device(req), req.body)));
fastify.post("/api/polls/:id/vote", async (req, reply) =>
	send(reply, await api.vote(device(req), req.params.id, req.body))
);
fastify.post("/api/requests", async (req, reply) => send(reply, await api.addRequest(device(req), req.body)));
fastify.post("/api/reports", async (req, reply) => send(reply, await api.addReport(device(req), req.body)));

fastify.get("/api/inbox", async (req, reply) => send(reply, await api.inbox(key(req))));
fastify.delete("/api/requests/:id", async (req, reply) => send(reply, await api.deleteRequest(key(req), req.params.id)));
fastify.delete("/api/reports/:id", async (req, reply) => send(reply, await api.deleteReport(key(req), req.params.id)));

fastify.get("/api/admin/polls", async (req, reply) => send(reply, await api.listPolls(key(req))));
fastify.post("/api/admin/polls", async (req, reply) => send(reply, await api.createPoll(key(req), req.body)));
fastify.patch("/api/admin/polls/:id", async (req, reply) =>
	send(reply, await api.setPollClosed(key(req), req.params.id, req.body))
);
fastify.delete("/api/admin/polls/:id", async (req, reply) => send(reply, await api.deletePoll(key(req), req.params.id)));

fastify.get("/api/admin/messages", async (req, reply) => send(reply, await api.listMessages(key(req))));
fastify.post("/api/admin/messages", async (req, reply) => send(reply, await api.sendMessage(key(req), req.body)));
fastify.delete("/api/admin/messages/:id", async (req, reply) =>
	send(reply, await api.deleteMessage(key(req), req.params.id))
);

fastify.get("/api/admin/users", async (req, reply) => send(reply, await api.users(key(req))));
fastify.post("/api/admin/bans", async (req, reply) => send(reply, await api.ban(key(req), req.body)));
fastify.delete("/api/admin/bans/:id", async (req, reply) => send(reply, await api.unban(key(req), req.params.id)));

fastify.setNotFoundHandler((res, reply) => {
        return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", () => {
        const address = fastify.server.address();

        // by default we are listening on 0.0.0.0 (every interface)
        // we just need to list a few
        console.log("Listening on:");
        console.log(`\thttp://localhost:${address.port}`);
        console.log(`\thttp://${hostname()}:${address.port}`);
        console.log(
                `\thttp://${
                        address.family === "IPv6" ? `[${address.address}]` : address.address
                }:${address.port}`
        );
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
        console.log("SIGTERM signal received: closing HTTP server");
        // Save anything still waiting (polls, bans...) before Render stops us.
        await Promise.race([data.flush().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
        fastify.close();
        process.exit(0);
}

data.load().catch(() => {}); // so bans apply from the first connection
syncAllowlist().catch(() => {});
setInterval(() => syncAllowlist().catch(() => {}), 60 * 1000).unref();

let port = parseInt(process.env.PORT || "");

if (isNaN(port)) port = 8080;

fastify.listen({
        port: port,
        host: "0.0.0.0",
});

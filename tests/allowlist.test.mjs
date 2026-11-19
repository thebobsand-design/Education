import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDomain, allowedDomains, buildDenyRegex } from "../src/allowlist.js";
import { sanitizeEntry } from "../src/games.js";

const blocked = (domains, host) => buildDenyRegex(domains).test(host);

test("normalizeDomain", () => {
	assert.equal(normalizeDomain("CDN.Example.com"), "cdn.example.com");
	assert.equal(normalizeDomain("*.example.com"), "example.com");
	assert.equal(normalizeDomain(".example.com"), "example.com");
	assert.equal(normalizeDomain("https://a.example.com/path?x=1"), "a.example.com");
	for (const bad of ["", "localhost", "a b.com", "a..com", "-a.com", "exa_mple.com", 5, null, "x".repeat(101) + ".com"]) {
		assert.equal(normalizeDomain(bad), null, String(bad));
	}
});
test("allowedDomains uses each card's site without www, plus extras", () => {
	const out = allowedDomains([
		{ url: "https://www.nettleweb.com/#/games/x", allow: ["cdn.other.net", "*.assets.io"] },
		{ url: "https://play.example.org/a" },
		{ url: "not a url" },
	]);
	assert.deepEqual(out, ["assets.io", "cdn.other.net", "nettleweb.com", "play.example.org"]);
	assert.deepEqual(allowedDomains(undefined), []);
});
test("deny regex lets allowed hosts and their subdomains through", () => {
	const d = ["nettleweb.com", "cdn.other.net"];
	for (const ok of ["nettleweb.com", "www.nettleweb.com", "a.b.nettleweb.com", "NettleWeb.com", "cdn.other.net", "nettleweb.com:443", "nettleweb.com."]) {
		assert.equal(blocked(d, ok), false, ok);
	}
});
test("deny regex blocks everything else, including look-alikes", () => {
	const d = ["nettleweb.com", "cdn.other.net"];
	for (const bad of ["google.com", "evilnettleweb.com", "nettleweb.com.evil.com", "other.net", "x.other.net", "nettleweb.co", "1.2.3.4", "", "nettleweb.com:abc"]) {
		assert.equal(blocked(d, bad), true, bad);
	}
});
test("empty list blocks everything", () => {
	assert.equal(blocked([], "nettleweb.com"), true);
	assert.equal(blocked([], "anything.example"), true);
});
test("regex characters in domains are escaped", () => {
	assert.equal(blocked(["a-b.com"], "axb.com"), true);
	assert.equal(blocked(["a.com"], "abcom"), true);
});
test("cards keep an 'allow' list only when one is given", () => {
	const none = sanitizeEntry({ name: "A", url: "https://a.example" });
	assert.equal(none.ok, true);
	assert.equal("allow" in none.value, false);
	const some = sanitizeEntry({ name: "A", url: "https://a.example", allow: "cdn.x.com, *.y.org  z.net" });
	assert.deepEqual(some.value.allow, ["cdn.x.com", "y.org", "z.net"]);
	assert.equal(sanitizeEntry({ name: "A", url: "https://a.example", allow: "not a site!" }).ok, false);
	assert.equal(sanitizeEntry({ name: "A", url: "https://a.example", allow: Array.from({ length: 11 }, (_, i) => `s${i}.com`) }).ok, false);
});

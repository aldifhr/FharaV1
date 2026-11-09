import { test } from "node:test";
import assert from "node:assert/strict";
import { checkApiRequest, isAllowedHost, isSameOrigin } from "../../lib/requestGuard.ts";

const req = (method, headers) => ({
  method,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

test("allows loopback hosts and rejects others unless configured", () => {
  assert.equal(isAllowedHost("localhost:3000", {}), true);
  assert.equal(isAllowedHost("127.0.0.1:3000", {}), true);
  assert.equal(isAllowedHost("[::1]:3000", {}), true);
  assert.equal(isAllowedHost("evil.example:3000", {}), false);
  assert.equal(isAllowedHost("192.168.1.5:3000", {}), false);
  assert.equal(isAllowedHost("192.168.1.5:3000", { FHARA_ALLOWED_HOSTS: "192.168.1.5" }), true);
  assert.equal(isAllowedHost("fhara.example", { FHARA_ALLOWED_HOSTS: "fhara.example:443, other" }), false);
  assert.equal(isAllowedHost("fhara.example:443", { FHARA_ALLOWED_HOSTS: "fhara.example:443" }), true);
  assert.equal(isAllowedHost(null, {}), false);
});

test("DNS-rebinding Host is rejected even for GET", () => {
  const r = checkApiRequest(req("GET", { host: "attacker.example:3000" }), {});
  assert.equal(r.ok, false);
});

test("same-origin POST passes, cross-site POST fails", () => {
  const ok = checkApiRequest(req("POST", { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }), {});
  assert.equal(ok.ok, true);
  const alias = checkApiRequest(req("POST", { host: "127.0.0.1:3000", origin: "http://localhost:3000" }), {});
  assert.equal(alias.ok, true);
  const cross = checkApiRequest(req("POST", { host: "localhost:3000", origin: "https://evil.example" }), {});
  assert.equal(cross.ok, false);
  const otherPort = checkApiRequest(req("POST", { host: "localhost:3000", origin: "http://localhost:5173" }), {});
  assert.equal(otherPort.ok, false);
  const nullOrigin = checkApiRequest(req("POST", { host: "localhost:3000", origin: "null" }), {});
  assert.equal(nullOrigin.ok, false);
  const fetchMeta = checkApiRequest(req("POST", { host: "localhost:3000", "sec-fetch-site": "cross-site" }), {});
  assert.equal(fetchMeta.ok, false);
});

test("POST without Origin (curl) passes the default check but not the strict one", () => {
  const input = req("POST", { host: "localhost:3000" });
  assert.equal(checkApiRequest(input, {}).ok, true);
  assert.equal(isSameOrigin(input, true), false);
  assert.equal(isSameOrigin(req("POST", { host: "localhost:3000", origin: "http://localhost:3000" }), true), true);
});

test("GET from another site is allowed (no CORS, response unreadable)", () => {
  const r = checkApiRequest(req("GET", { host: "localhost:3000", "sec-fetch-site": "cross-site" }), {});
  assert.equal(r.ok, true);
});

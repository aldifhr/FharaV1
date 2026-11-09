import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpUrl, isBlockedAddress, UrlBlockedError } from "../../lib/ssrfGuard.ts";

test("blocks private, loopback, link-local and metadata addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "224.0.0.1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("URL checks resolve DNS and refuse non-http schemes", async () => {
  const resolver = (map) => async (host) => {
    if (!(host in map)) throw new Error("nx");
    return map[host];
  };
  const r = resolver({ "example.com": ["93.184.216.34"], "rebind.example": ["93.184.216.34", "127.0.0.1"], "meta.example": ["169.254.169.254"] });
  assert.equal(await assertPublicHttpUrl("https://example.com/x", r), "https://example.com/x");
  for (const bad of ["file:///etc/passwd", "ftp://example.com", "http://localhost:3210", "http://127.0.0.1", "http://[::1]/", "http://169.254.169.254/latest", "http://rebind.example", "http://meta.example", "http://nx.example", "http://u:p@example.com", "http://foo.internal", "not a url"]) {
    await assert.rejects(assertPublicHttpUrl(bad, r), UrlBlockedError, bad);
  }
});

import { describe, expect, it } from "vitest";
import { assertUrlAllowed, extractDomain, extractUrls, isBlockedHost } from "@/tools/webClient";

describe("webClient URL guard", () => {
  it("allows public domains and public IPs", () => {
    expect(assertUrlAllowed("https://example.com/page").hostname).toBe("example.com");
    expect(assertUrlAllowed("http://93.184.216.34/").hostname).toBe("93.184.216.34");
  });

  it("blocks schemes other than http/https", () => {
    expect(() => assertUrlAllowed("file:///etc/passwd")).toThrow(/Blocked URL scheme/);
    expect(() => assertUrlAllowed("data:text/plain,hi")).toThrow(/Blocked URL scheme/);
  });

  it("blocks loopback and private IPs via tldts, not regex", () => {
    for (const url of [
      "http://localhost:3000/",
      "http://127.0.0.1/admin",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[fe80::1]/",
    ]) {
      expect(() => assertUrlAllowed(url), url).toThrow(/Blocked internal URL/);
    }
  });

  it("blocks cloud-metadata hostnames", () => {
    expect(() => assertUrlAllowed("http://metadata.google.internal/computeMetadata/v1/")).toThrow(
      /Blocked internal URL/
    );
    expect(() => assertUrlAllowed("http://instance-data/latest/meta-data/")).toThrow(
      /Blocked internal URL/
    );
  });

  it("blocks malformed and single-label hosts", () => {
    expect(isBlockedHost("intranet")).toBe(true);
    expect(isBlockedHost("foo..bar")).toBe(true);
    expect(isBlockedHost("sub.example.com")).toBe(false);
  });

  it("extractDomain returns the registrable domain", () => {
    expect(extractDomain("sub.example.co.uk")).toBe("example.co.uk");
    expect(extractDomain("example.com")).toBe("example.com");
  });

  it("extractUrls strips trailing punctuation and dedupes", () => {
    expect(extractUrls("see https://a.example/x, and https://a.example/x.")).toEqual([
      "https://a.example/x",
    ]);
  });
});

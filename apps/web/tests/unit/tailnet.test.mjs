import test from "node:test";
import assert from "node:assert/strict";
import {
  detectTailscaleIPv4,
  isTailscaleIPv4,
  nextPort,
  parseTailscaleIpOutput,
  pickTailscaleIPv4,
  wantsTailscale,
  withAllowedHosts,
} from "../../scripts/tailnet.mjs";

test("FHARA_BIND_TAILSCALE is opt-in", () => {
  assert.equal(wantsTailscale({}), false);
  assert.equal(wantsTailscale({ FHARA_BIND_TAILSCALE: "1" }), true);
  assert.equal(wantsTailscale({ FHARA_BIND_TAILSCALE: "On" }), true);
  assert.equal(wantsTailscale({ FHARA_BIND_TAILSCALE: "0" }), false);
});

test("only 100.64.0.0/10 counts as a Tailscale address", () => {
  assert.equal(isTailscaleIPv4("100.101.102.103"), true);
  assert.equal(isTailscaleIPv4("100.64.0.1"), true);
  assert.equal(isTailscaleIPv4("100.128.0.1"), false);
  assert.equal(isTailscaleIPv4("100.63.0.1"), false);
  assert.equal(isTailscaleIPv4("192.168.1.5"), false);
  assert.equal(isTailscaleIPv4("0.0.0.0"), false);
  assert.equal(isTailscaleIPv4("100.300.1.1"), false);
});

test("interfaces: tailscale0 wins, internal and IPv6 are skipped", () => {
  const ifaces = {
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    eth0: [{ family: "IPv4", address: "192.168.1.5", internal: false }],
    other: [{ family: "IPv4", address: "100.70.0.9", internal: false }],
    tailscale0: [
      { family: "IPv6", address: "fd7a:115c::1", internal: false },
      { family: "IPv4", address: "100.101.1.2", internal: false },
    ],
  };
  assert.equal(pickTailscaleIPv4(ifaces), "100.101.1.2");
  assert.equal(pickTailscaleIPv4({ eth0: ifaces.eth0 }), null);
});

test("CLI output is parsed; detection never falls back to 0.0.0.0", () => {
  assert.equal(parseTailscaleIpOutput("100.101.1.2\n"), "100.101.1.2");
  assert.equal(parseTailscaleIpOutput("not running"), null);
  const mockExec = () => "100.99.0.7\n";
  assert.equal(detectTailscaleIPv4({ exec: mockExec, interfaces: {} }), "100.99.0.7");
  const failing = () => {
    throw new Error("ENOENT");
  };
  assert.equal(detectTailscaleIPv4({ exec: failing, interfaces: { eth0: [{ family: "IPv4", address: "10.0.0.2", internal: false }] } }), null);
});

test("port and allowed hosts", () => {
  assert.equal(nextPort(["-p", "4000"], {}), 4000);
  assert.equal(nextPort(["--port=4100"], {}), 4100);
  assert.equal(nextPort([], { PORT: "3100" }), 3100);
  assert.equal(nextPort([], {}), 3000);
  assert.equal(withAllowedHosts("a.local", ["100.1.1.1", "a.local"]), "a.local,100.1.1.1");
  assert.equal(withAllowedHosts(undefined, ["100.1.1.1", "100.1.1.1:3000"]), "100.1.1.1,100.1.1.1:3000");
});

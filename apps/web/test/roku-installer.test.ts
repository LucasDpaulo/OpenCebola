import assert from "node:assert/strict";
import test from "node:test";
import { rokuInstallerUrl } from "../app/configuracoes/tv/roku-installer";

test("normaliza IPv4 privados usados pelo instalador Roku", () => {
  assert.equal(rokuInstallerUrl(" 192.168.1.45 "), "http://192.168.1.45");
  assert.equal(rokuInstallerUrl("10.0.0.8"), "http://10.0.0.8");
  assert.equal(rokuInstallerUrl("172.16.0.1"), "http://172.16.0.1");
  assert.equal(rokuInstallerUrl("172.31.255.254"), "http://172.31.255.254");
});

test("recusa endereço fora da LAN e entrada capaz de alterar a URL", () => {
  for (const value of [
    "", "192.168.1", "192.168.1.256", "192.168.1.5:8060", "http://192.168.1.5",
    "192.168.1.5/plugin_install", "user@192.168.1.5", "127.0.0.1", "169.254.1.1",
    "172.15.0.1", "172.32.0.1", "8.8.8.8", "roku.local", "224.0.0.1", "010.0.0.8"
  ]) assert.equal(rokuInstallerUrl(value), null, value);
});

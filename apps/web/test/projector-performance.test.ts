import assert from "node:assert/strict";
import test from "node:test";
import { isLowEndDevice } from "../app/device-capability.js";
import { rankAutomaticSources } from "../app/player/source-ranking.js";
import { shouldPublishPlayerPosition } from "../app/player/player-update-policy.js";

const cases = [
  { name: "projetor com UA de celular e controle remoto", native: true, touch: 0, ua: "Android Mobile", lowPower: true },
  { name: "Android TV com memória reportada alta", native: true, touch: 1, ua: "Android TV", lowPower: true },
  { name: "projetor com WebView sem informação de toque", native: true, touch: undefined, ua: "Android Mobile", lowPower: true },
  { name: "celular potente com toque", native: true, touch: 5, ua: "Android Mobile", lowPower: false },
  { name: "computador sem toque", native: false, touch: 0, ua: "Linux Desktop", lowPower: false }
];

for (const device of cases) {
  test(`perfil de desempenho: ${device.name}`, () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      innerWidth: 3840,
      matchMedia: () => ({ matches: false }),
      Capacitor: { isNativePlatform: () => device.native, getPlatform: () => "android" }
    } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      userAgent: device.ua, maxTouchPoints: device.touch, deviceMemory: 8, hardwareConcurrency: 8
    } });
    try {
      const lowPower = isLowEndDevice();
      assert.equal(lowPower, device.lowPower);
      const ranked = rankAutomaticSources([
        { id: "pesada", addonId: "a", kind: "direct" as const, quality: "4K", label: "2160p REMUX", seeders: 100 },
        { id: "leve", addonId: "a", kind: "direct" as const, quality: "1080p", label: "1080p WEB-DL H264", seeders: 1 }
      ], { originalLanguage: null, compactScreen: false, lowPower, compatible: () => true });
      assert.equal(ranked[0]?.id, lowPower ? "leve" : "pesada");
      assert.equal(shouldPublishPlayerPosition(10, 11, {
        lowPower, visible: false, playing: true, skipBlocks: [], hasNext: false, duration: 1200
      }), !lowPower);
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });
}

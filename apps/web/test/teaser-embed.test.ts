import assert from "node:assert/strict";
import test from "node:test";
import { youtubeEmbedUrl } from "../app/teaser-embed.js";

test("trailer incorporado identifica o aplicativo e preserva os parâmetros do player", () => {
  const url = new URL(youtubeEmbedUrl("M7lc1UVf-VE", {
    autoplay: "1",
    enablejsapi: "1"
  }));

  assert.equal(url.origin, "https://www.youtube-nocookie.com");
  assert.equal(url.pathname, "/embed/M7lc1UVf-VE");
  assert.equal(url.searchParams.get("origin"), "http://localhost:3000");
  assert.equal(url.searchParams.get("widget_referrer"), "http://localhost:3000");
  assert.equal(url.searchParams.get("autoplay"), "1");
  assert.equal(url.searchParams.get("enablejsapi"), "1");
});

test("no app do PC o trailer passa pela página-ponte do domínio", () => {
  const url = new URL(youtubeEmbedUrl("M7lc1UVf-VE", { autoplay: "1" }, true));
  assert.equal(url.origin, "http://localhost:3000");
  assert.equal(url.pathname, "/yt-relay.html");
  assert.equal(url.searchParams.get("v"), "M7lc1UVf-VE");
  assert.equal(url.searchParams.get("autoplay"), "1");
});

test("só tauri:// e tauri.localhost precisam da ponte", async () => {
  const { needsYoutubeRelay } = await import("../app/teaser-embed.js");
  assert.equal(needsYoutubeRelay({ protocol: "tauri:", hostname: "localhost" }), true);
  assert.equal(needsYoutubeRelay({ protocol: "http:", hostname: "tauri.localhost" }), true);
  assert.equal(needsYoutubeRelay({ protocol: "https:", hostname: "localhost" }), false);
  assert.equal(needsYoutubeRelay({ protocol: "https:", hostname: "instance.example.invalid" }), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { subtitleToVtt } from "../src/stremio/subtitle-format.js";

test("relay converte falas ASS com tags e quebras de linha para WebVTT", () => {
  const ass = `[Script Info]\nTitle: One Piece\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:01:02.30,0:01:05.00,Default,,0,0,0,,{\\i1}Olá\\Nmundo, Luffy!\n`;
  assert.equal(subtitleToVtt(ass), "WEBVTT\n\n00:01:02.300 --> 00:01:05.000\nOlá\nmundo, Luffy!\n");
});

test("relay aceita espaços na seção Events e mantém quebras duplas dentro da mesma fala", () => {
  const ass = `[Script Info]\nTitle: One Piece\n[Events] \nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:03.00,Primeira\\N\\NSegunda\n`;
  assert.equal(subtitleToVtt(ass), "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nPrimeira\nSegunda\n");
});

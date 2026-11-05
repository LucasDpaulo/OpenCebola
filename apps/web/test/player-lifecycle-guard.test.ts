import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// O cleanup deste efeito destrói o motor. Dados que chegam durante a reprodução não podem
// entrar em suas dependências; fazê-lo transforma uma atualização de dados em um novo load.
test("atualizar progresso ou legendas não recria a sessão nativa", () => {
  const source = readFileSync(new URL("../app/titulo/title-experience.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("title.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let checked = 0;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "useEffect" &&
        node.arguments[0]?.getText(file).includes("nativo.destroy()")) {
      checked++;
      const dependencies = node.arguments[1];
      assert.ok(dependencies && ts.isArrayLiteralExpression(dependencies));
      const names = dependencies.elements.map((item) => item.getText(file));
      for (const value of ["activeSaved", "savedItems", "subtitles", "defaultSubtitleId"]) {
        assert.ok(!names.includes(value), `${value} recriaria o motor durante a reprodução`);
      }
      assert.ok(names.includes("selectedStream"));
      assert.ok(names.includes("selectedVideo"));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(checked, 1);
});

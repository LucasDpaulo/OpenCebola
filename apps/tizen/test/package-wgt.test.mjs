import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const verifier = path.join(root, "scripts/tizen-verificar-wgt.sh");
const config = `<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets"
  id="br.cebola.tv" version="0.1.0">
  <tizen:application id="CEBOLA0001.CebolaTV" package="CEBOLA0001" required_version="10.0" />
  <content src="www/index.html" />
  <tizen:profile name="tv" />
</widget>
`;

const prefixedConfig = `<?xml version="1.0" encoding="UTF-8"?>
<w:widget xmlns:w="http://www.w3.org/ns/widgets" xmlns:tz="http://tizen.org/ns/widgets"
  id="br.cebola.tv" version="0.1.0">
  <tz:application id="CEBOLA0001.CebolaTV" package="CEBOLA0001" required_version="10.0" />
  <w:content src="www/index.html" />
  <tz:profile name="tv" />
</w:widget>
`;

const signature = `<?xml version="1.0" encoding="UTF-8"?>
<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
  <SignedInfo>
    <CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11" />
    <SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256" />
    <Reference URI="">
      <DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256" />
      <DigestValue>AA==</DigestValue>
    </Reference>
  </SignedInfo>
  <SignatureValue>AA==</SignatureValue>
  <KeyInfo><X509Data><X509Certificate>AA==</X509Certificate></X509Data></KeyInfo>
</Signature>
`;

const prefixedSignature = `<?xml version="1.0" encoding="UTF-8"?>
<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <ds:SignedInfo>
    <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11" />
    <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256" />
    <ds:Reference URI="">
      <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256" />
      <ds:DigestValue>AA==</ds:DigestValue>
    </ds:Reference>
  </ds:SignedInfo>
  <ds:SignatureValue>AA==</ds:SignatureValue>
  <ds:KeyInfo><ds:X509Data><ds:X509Certificate>AA==</ds:X509Certificate></ds:X509Data></ds:KeyInfo>
</ds:Signature>
`;

function makeWgt({
  signaturePresent = true,
  secret = false,
  secretName = "credentials.p12",
  appId = "CEBOLA0001.CebolaTV",
  configXml = config,
  signatureXml = signature,
} = {}) {
  const fixture = mkdtempSync(path.join(tmpdir(), "cebola-tizen-wgt-"));
  const wgt = path.join(fixture, "app.wgt");
  mkdirSync(path.join(fixture, "www"));
  writeFileSync(path.join(fixture, "config.xml"), configXml.replace("CEBOLA0001.CebolaTV", appId));
  writeFileSync(path.join(fixture, "www/index.html"), "<!doctype html>");
  if (signaturePresent) {
    writeFileSync(path.join(fixture, "author-signature.xml"), signatureXml);
    writeFileSync(path.join(fixture, "signature1.xml"), signatureXml);
  } else {
    writeFileSync(path.join(fixture, "author-signature.xml"), "");
    writeFileSync(path.join(fixture, "signature1.xml"), "");
  }
  if (secret) {
    const secretPath = path.join(fixture, secretName);
    mkdirSync(path.dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, "secret");
  }
  execFileSync("zip", ["-qr", wgt, "."], { cwd: fixture });
  return { fixture, wgt };
}

function verify(wgt) {
  return spawnSync("bash", [verifier, wgt], { cwd: root, encoding: "utf8" });
}

function appendDuplicate(wgt, source, entry) {
  execFileSync("python3", [
    "-c",
    `import sys
import warnings
import zipfile

warnings.simplefilter("ignore", UserWarning)
with zipfile.ZipFile(sys.argv[1], "a") as archive:
    archive.write(sys.argv[2], sys.argv[3])
`,
    wgt,
    source,
    entry,
  ]);
}

test("verificador aceita WGT estruturalmente válido sem prometer validação criptográfica", () => {
  const { fixture, wgt } = makeWgt();
  try {
    const result = verify(wgt);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      "OK: estrutura do WGT e CRC válidos; assinatura criptográfica não verificada\n",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("verificador recusa assinatura XML malformada com erro sanitizado", () => {
  const { fixture, wgt } = makeWgt({ signaturePresent: false });
  try {
    const result = verify(wgt);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /author-signature\.xml malformado/);
    assert.doesNotMatch(result.stderr, /Traceback/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("verificador recusa material secreto no WGT", () => {
  const { fixture, wgt } = makeWgt({ secret: true });
  try { assert.notEqual(verify(wgt).status, 0); } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("verificador não vaza o nome de material secreto", () => {
  const sensitiveName = "credentials/private-client-secret.p12";
  const { fixture, wgt } = makeWgt({ secret: true, secretName: sensitiveName });
  try {
    const result = verify(wgt);
    assert.equal(result.status, 3);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /private-client-secret/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("verificador recusa application ID inesperado", () => {
  const { fixture, wgt } = makeWgt({ appId: "OUTRO0001.App" });
  try { assert.notEqual(verify(wgt).status, 0); } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("verificador recusa nomes de entrada duplicados no ZIP", () => {
  const { fixture, wgt } = makeWgt();
  try {
    appendDuplicate(wgt, path.join(fixture, "config.xml"), "config.xml");
    const result = verify(wgt);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /entrada ZIP duplicada/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("verificador aceita prefixos XML legítimos no config Tizen", () => {
  const { fixture, wgt } = makeWgt({ configXml: prefixedConfig });
  try {
    const result = verify(wgt);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("verificador recusa config.xml malformado com erro sanitizado", () => {
  const { fixture, wgt } = makeWgt({ configXml: "<widget>" });
  try {
    const result = verify(wgt);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /config\.xml malformado/);
    assert.doesNotMatch(result.stderr, /Traceback/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("verificador aceita prefixos XML legítimos nas assinaturas XML DSig", () => {
  const { fixture, wgt } = makeWgt({ signatureXml: prefixedSignature });
  try {
    const result = verify(wgt);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("verificador recusa elemento Signature sem estrutura XML DSig", () => {
  const emptySignature = '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#" />';
  const { fixture, wgt } = makeWgt({ signatureXml: emptySignature });
  try {
    const result = verify(wgt);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /assinatura XML DSig inválida/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

const incompleteSignatures = [
  ["SignedInfo", signature.replaceAll("SignedInfo", "MissingSignedInfo")],
  ["CanonicalizationMethod", signature.replace(/\s*<CanonicalizationMethod[^>]+\/>/, "")],
  ["SignatureMethod", signature.replace(/\s*<SignatureMethod[^>]+\/>/, "")],
  ["Reference", signature.replace(/\s*<Reference[\s\S]*?<\/Reference>/, "")],
  ["DigestMethod", signature.replace(/\s*<DigestMethod[^>]+\/>/, "")],
  ["DigestValue", signature.replace("<DigestValue>AA==</DigestValue>", "<DigestValue />")],
  ["SignatureValue", signature.replace("<SignatureValue>AA==</SignatureValue>", "<SignatureValue />")],
  ["KeyInfo", signature.replace(/\s*<KeyInfo>[\s\S]*?<\/KeyInfo>/, "")],
];

for (const [missingElement, signatureXml] of incompleteSignatures) {
  test(`verificador recusa XML DSig sem ${missingElement}`, () => {
    const { fixture, wgt } = makeWgt({ signatureXml });
    try {
      const result = verify(wgt);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /assinatura XML DSig inválida/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test("verificador recusa motor declarado sem os arquivos do serviço", () => {
  const { fixture, wgt } = makeWgt({ configXml: config.replace("</widget>", '<tizen:service id="CEBOLA0001.Streaming" /></widget>') });
  try {
    const result = verify(wgt);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /motor local/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("verificador funciona sem ripgrep e continua bloqueando material secreto", () => {
  for (const secret of [false, true]) {
    const { fixture, wgt } = makeWgt({ secret });
    try {
      const bin = path.join(fixture, "bin");
      mkdirSync(bin);
      writeFileSync(path.join(bin, "rg"), "#!/bin/sh\necho 'ripgrep indisponivel' >&2\nexit 127\n", { mode: 0o755 });
      const result = spawnSync("bash", [verifier, wgt], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      });
      assert.equal(result.status, secret ? 3 : 0, result.stderr);
      assert.doesNotMatch(result.stderr, /ripgrep indisponivel/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});

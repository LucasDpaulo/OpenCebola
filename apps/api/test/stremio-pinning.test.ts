import assert from "node:assert/strict";
import test from "node:test";
import { pinnedLookup } from "../src/stremio/safe-http.js";

// pinnedLookup é o "lookup" injetado no https.request pra fixar o IP já validado (defesa contra
// DNS rebinding): entre validar o endereço e abrir o socket, o hostname nunca pode ser
// re-resolvido. Bug de produção: com autoSelectFamily (Happy Eyeballs, padrão desde o Node 20),
// o Node chama o lookup com options.all=true e espera o callback no formato array — callback(null,
// [{address, family}]), o mesmo contrato documentado de dns.lookup(..., {all:true}, ...). A
// implementação antiga só respondia no formato de 3 argumentos (null, address, family): o Node
// recebia a string do IP onde esperava a lista e a conexão morria com ERR_INVALID_IP_ADDRESS
// (req.on("error") convertia isso em UPSTREAM_UNAVAILABLE — nenhuma chamada a add-on completava).
// validatePublicHttpsUrl/pinnedAddress exigem IP público, então não dá pra reproduzir isso com
// servidor local: os testes aqui chamam pinnedLookup diretamente, sem abrir socket nenhum.

// IPs de documentação (RFC 5737 / RFC 3849): nunca são roteáveis de verdade, só provam que o
// endereço fixado é o entregue — nenhum teste aqui toca rede.
const pinnedV4 = { address: "203.0.113.9", family: 4 as const };
const pinnedV6 = { address: "2001:db8::9", family: 6 as const };
// Hostname deliberadamente diferente dos endereços acima, pra provar que o pinning ignora o que
// foi pedido: o parâmetro nem é lido pela implementação (por isso o "_" no nome dela).
const hostnamePedido = "addon.example.com";

test("pinnedLookup com options.all=true entrega um array [{address, family}] com o endereço fixado, nunca o hostname", () => {
  for (const pinned of [pinnedV4, pinnedV6]) {
    let recebido: unknown;
    pinnedLookup(pinned)(hostnamePedido, { all: true }, (err, address, family) => {
      assert.equal(err, null);
      assert.equal(family, undefined); // no formato array o 3º argumento não é usado
      recebido = address;
    });
    assert.deepEqual(recebido, [{ address: pinned.address, family: pinned.family }]);
  }
});

test("pinnedLookup sem options.all (ausente ou false) entrega (address, family) como argumentos separados, nunca o hostname", () => {
  for (const pinned of [pinnedV4, pinnedV6]) {
    for (const options of [{}, { all: false }]) {
      let enderecoRecebido: unknown;
      let familyRecebida: unknown;
      pinnedLookup(pinned)(hostnamePedido, options, (err, address, family) => {
        assert.equal(err, null);
        enderecoRecebido = address;
        familyRecebida = family;
      });
      assert.equal(enderecoRecebido, pinned.address);
      assert.equal(familyRecebida, pinned.family);
    }
  }
});

test("regressão: no formato antigo de 3 argumentos, o Node em modo all=true acabava lendo undefined onde esperava o endereço", () => {
  // Reproduz só o retorno da implementação antiga (o 1-liner do bug original), sem reintroduzi-la
  // no código-fonte: sempre callback(null, address, family), ignorando options.all por completo.
  const lookupFormatoAntigo = (
    _hostname: string,
    _options: unknown,
    callback: (err: null, address: string, family: 4 | 6) => void
  ): void => callback(null, pinnedV4.address, pinnedV4.family);

  // Simula a chamada do Node no modo all=true, lendo o resultado do jeito que o contrato de
  // dns.lookup(..., {all:true}, ...) documenta: addresses é um array de objetos {address, family}.
  let candidatoAntigo: unknown;
  lookupFormatoAntigo(hostnamePedido, { all: true }, (_err, address) => {
    // Cast estreito e comentado: aqui estamos deliberadamente reproduzindo o descompasso de tipo
    // que causava o bug (o "address" desta função antiga é sempre string, nunca o array esperado).
    const addresses = address as unknown as Array<{ address: string }>;
    candidatoAntigo = addresses[0]?.address;
  });
  // "203.0.113.9"[0] é o caractere "2", que não tem propriedade .address: daí o undefined —
  // exatamente o valor que virava ERR_INVALID_IP_ADDRESS em produção.
  assert.equal(candidatoAntigo, undefined);

  // O pinnedLookup corrigido, chamado do mesmo jeito (mesmo modo all=true), entrega o endereço de
  // verdade: o valor lido pelo callback não é (e nunca mais deve ser) undefined.
  let candidatoNovo: unknown;
  pinnedLookup(pinnedV4)(hostnamePedido, { all: true }, (_err, address) => {
    candidatoNovo = Array.isArray(address) ? address[0]?.address : undefined;
  });
  assert.notEqual(candidatoNovo, undefined);
  assert.equal(candidatoNovo, pinnedV4.address);
});

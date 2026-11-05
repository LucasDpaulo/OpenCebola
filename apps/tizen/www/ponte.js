// Ponte AVPlay <-> site remoto. A casca local (index.html) embute o site num <iframe> e é a única
// janela com window.webapis (o AVPlay não existe no conteúdo remoto); o site pede as operações
// por postMessage e a casca as executa aqui. A lógica fica neste arquivo, sem tocar em DOM, para
// poder ser testada em Node com um avplay falso (apps/tizen/test/ponte.test.mjs).
//
// Protocolo (versão 1) — mensagens sempre objetos com o campo `cebola`:
//   site  -> casca  { cebola: "ola" }                          responde { cebola: "casca", versao, avplay }
//   site  -> casca  { cebola: "avplay", id, op, args }         responde { cebola: "avplay:resposta", id, ok, valor | erro }
//   casca -> site   { cebola: "avplay:evento", tipo, valor }   posicao | fim | erro | legenda | buffer
//   site  -> casca  { cebola: "sair" }                         encerra o app
(function () {
  "use strict";

  var ORIGEM_SITE = (typeof window !== "undefined" && window.OPENCEBOLA_INSTANCE)
    ? window.OPENCEBOLA_INSTANCE.webOrigin : "https://instance.example.invalid";
  var VERSAO = 1;
  // O oncurrentplaytime do AVPlay dispara várias vezes por segundo; o site só precisa de um
  // ritmo que mova a barra de progresso, e cada postMessage custa na CPU fraca da TV.
  var INTERVALO_POSICAO_MS = 250;
  // Alguns firmwares aceitam seekTo mas nunca chamam o callback; sem este limite a resposta
  // ficaria pendente para sempre e o site travaria esperando.
  var ESPERA_CALLBACK_MS = 3000;
  var TAMANHO_MAX_ERRO = 120;

  function ehObjeto(valor) {
    return valor !== null && typeof valor === "object";
  }

  function ehNumero(valor) {
    return typeof valor === "number" && isFinite(valor);
  }

  function criarPonte(opcoes) {
    var config = ehObjeto(opcoes) ? opcoes : {};
    var enviar = typeof config.enviar === "function" ? config.enviar : function () {};
    var sair = typeof config.sair === "function" ? config.sair : function () {};
    var origem = typeof config.origem === "string" ? config.origem : ORIGEM_SITE;
    // Quem devolve a janela do iframe do site. Sem ela (ou sem janela), nenhuma mensagem passa:
    // comparar event.source com undefined aceitaria mensagens sem origem.
    var janelaSite = typeof config.janelaSite === "function" ? config.janelaSite : function () { return null; };
    var agora = typeof config.agora === "function" ? config.agora : function () { return Date.now(); };
    var esperaCallbackMs = ehNumero(config.esperaCallbackMs) ? config.esperaCallbackMs : ESPERA_CALLBACK_MS;

    var aberto = false;       // há uma sessão AVPlay aberta por esta ponte (open sem close)
    var geracao = 0;          // invalida o listener de uma sessão anterior depois de abrir/parar
    var ultimaPosicaoEm = null;
    var ultimaUrl = "";       // só para esconder a URL em mensagens de erro; nunca é logada

    function avplay() {
      var valor = typeof config.avplay === "function" ? config.avplay() : config.avplay;
      return ehObjeto(valor) ? valor : null;
    }

    // Erros do AVPlay (WebAPIException) podem citar a URL da mídia, que carrega token do
    // Real-Debrid. A resposta ao site e qualquer log só levam texto curto e sem URL.
    function curto(valor) {
      var texto;
      try {
        if (ehObjeto(valor) && (valor.name || valor.message)) {
          texto = (valor.name ? String(valor.name) : "") +
            (valor.name && valor.message ? ": " : "") +
            (valor.message ? String(valor.message) : "");
        } else {
          texto = String(valor);
        }
      } catch (erro) { texto = "erro"; }
      if (ultimaUrl) texto = texto.split(ultimaUrl).join("[url]");
      texto = texto.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]");
      if (texto.length > TAMANHO_MAX_ERRO) texto = texto.slice(0, TAMANHO_MAX_ERRO);
      return texto || "erro";
    }

    function emitir(tipo, valor) {
      enviar({ cebola: "avplay:evento", tipo: tipo, valor: valor });
    }

    function normalizarInfo(extra) {
      if (typeof extra === "string") {
        try {
          var lido = JSON.parse(extra);
          return ehObjeto(lido) && !Array.isArray(lido) ? lido : {};
        } catch (erro) { return {}; }
      }
      return ehObjeto(extra) && !Array.isArray(extra) ? extra : {};
    }

    function normalizarFaixas(lista) {
      var saida = [];
      if (!lista || typeof lista.length !== "number") return saida;
      for (var i = 0; i < lista.length; i++) {
        var faixa = lista[i];
        if (!ehObjeto(faixa)) continue;
        saida.push({
          index: faixa.index,
          tipo: String(faixa.type).toUpperCase(),
          info: normalizarInfo(faixa.extra_info)
        });
      }
      return saida;
    }

    // Callbacks do listener ficam presos à geração em que foram criados: um evento atrasado de
    // um vídeo já fechado não pode chegar ao site como se fosse do vídeo atual.
    function criarListener(minhaGeracao) {
      function vigente() { return minhaGeracao === geracao; }
      return {
        oncurrentplaytime: function (ms) {
          if (!vigente()) return;
          var t = agora();
          if (ultimaPosicaoEm !== null && t - ultimaPosicaoEm < INTERVALO_POSICAO_MS) return;
          ultimaPosicaoEm = t;
          emitir("posicao", ms);
        },
        onstreamcompleted: function () { if (vigente()) emitir("fim", null); },
        onerror: function (tipo) { if (vigente()) emitir("erro", curto(tipo)); },
        onerrormsg: function (tipo, mensagem) {
          if (vigente()) emitir("erro", curto(String(tipo) + (mensagem ? ": " + String(mensagem) : "")));
        },
        onsubtitlechange: function (duracao, texto) {
          if (vigente()) emitir("legenda", { texto: texto === undefined || texto === null ? "" : String(texto), duracao: duracao });
        },
        onbufferingstart: function () { if (vigente()) emitir("buffer", "inicio"); },
        onbufferingcomplete: function () { if (vigente()) emitir("buffer", "fim"); },
        // Alguns firmwares esperam todos os callbacks no objeto do listener.
        onbufferingprogress: function () {},
        onevent: function () {},
        ondrmevent: function () {}
      };
    }

    // Para e fecha a sessão aberta. Nunca lança: é chamada em recarga de página, troca de
    // vídeo e erro, momentos em que o AVPlay pode estar em qualquer estado.
    function parar() {
      geracao += 1;
      var av = avplay();
      if (!aberto) return;
      aberto = false;
      if (!av) return;
      try { av.stop(); } catch (erro) { /* já parado ou nunca preparado */ }
      try { av.close(); } catch (erro2) { /* já fechado */ }
    }

    // seekTo com callbacks: responde quando o AVPlay confirma, falha se ele recusa e segue
    // depois do limite se o firmware nunca chamar de volta.
    function buscarEm(av, ms) {
      return new Promise(function (resolve, reject) {
        var resolvido = false;
        var temporizador = null;
        function concluir(erro) {
          if (resolvido) return;
          resolvido = true;
          if (temporizador !== null) clearTimeout(temporizador);
          if (erro) reject(erro); else resolve();
        }
        temporizador = setTimeout(function () { concluir(null); }, esperaCallbackMs);
        try {
          av.seekTo(Math.max(0, Math.round(ms)), function () { concluir(null); }, function (erro) { concluir(erro || "seek"); });
        } catch (erro) { concluir(erro); }
      });
    }

    function prepararEm(av) {
      return new Promise(function (resolve, reject) {
        av.prepareAsync(function () { resolve(); }, function (erro) { reject(erro || "prepare"); });
      });
    }

    function listarFaixas(av) {
      return normalizarFaixas(av.getTotalTrackInfo());
    }

    function abrir(av, args) {
      if (typeof args.url !== "string" || !args.url) throw new Error("url ausente");
      var inicio = ehNumero(args.inicio) ? args.inicio : 0;
      parar();
      ultimaUrl = args.url;
      ultimaPosicaoEm = null;
      var minhaGeracao = geracao;
      var sequencia;
      try {
        av.open(args.url);
        aberto = true;
        av.setDisplayRect(0, 0, 1920, 1080);
        av.setListener(criarListener(minhaGeracao));
        sequencia = prepararEm(av);
      } catch (erro) {
        parar();
        throw erro;
      }
      return sequencia.then(function () {
        if (minhaGeracao !== geracao) throw new Error("aberto de novo antes de ficar pronto");
        return inicio > 0 ? buscarEm(av, inicio * 1000) : null;
      }).then(function () {
        if (minhaGeracao !== geracao) throw new Error("aberto de novo antes de ficar pronto");
        // Sem play() aqui: o site decide quando começar (depois de escolher áudio e legenda).
        return { duracao: av.getDuration(), faixas: listarFaixas(av) };
      }).then(null, function (erro) {
        // Falhou depois do open: fecha para não deixar o AVPlay preso numa sessão sem dono.
        if (minhaGeracao === geracao) parar();
        throw erro;
      });
    }

    // Cada operação devolve o valor da resposta ou uma Promise dele; lançar vira ok:false.
    var operacoes = {
      abrir: abrir,
      tocar: function (av) { av.play(); return null; },
      pausar: function (av) { av.pause(); return null; },
      buscar: function (av, args) {
        if (!ehNumero(args.segundos) || args.segundos < 0) throw new Error("segundos inválido");
        return buscarEm(av, args.segundos * 1000).then(function () { return null; });
      },
      audio: function (av, args) {
        if (!ehNumero(args.index)) throw new Error("index inválido");
        av.setSelectTrack("AUDIO", args.index);
        return null;
      },
      legenda: function (av, args) {
        if (args.index === null) {
          av.setSilentSubtitle(true);
          return null;
        }
        if (!ehNumero(args.index)) throw new Error("index inválido");
        av.setSelectTrack("TEXT", args.index);
        av.setSilentSubtitle(false);
        return null;
      },
      faixas: function (av) {
        return { faixas: listarFaixas(av), atuais: normalizarFaixas(av.getCurrentStreamInfo()) };
      },
      estado: function (av) {
        return { estado: av.getState(), posicao: av.getCurrentTime() };
      }
    };

    function responder(id, ok, resto) {
      var resposta = { cebola: "avplay:resposta", id: id, ok: ok };
      if (ok) resposta.valor = resto; else resposta.erro = resto;
      enviar(resposta);
    }

    function executar(id, op, args) {
      if (op.indexOf("streaming.") === 0 && config.streaming) {
        return config.streaming.call(op.slice(10), args).then(
          function (valor) { responder(id, true, valor); },
          function (erro) {
            // Repassa o motivo do motor ("Torrent sem resposta", "lento demais") ao site.
            var motivo = erro && typeof erro.message === "string" ? erro.message.slice(0, 160) : "";
            responder(id, false, motivo || "Não foi possível usar esta fonte no motor da TV.");
          }
        );
      }
      if (op === "parar") {
        // Nunca falha: o site pede parar ao sair do player e precisa poder confiar nisso.
        parar();
        responder(id, true, null);
        return Promise.resolve();
      }
      var funcao = Object.prototype.hasOwnProperty.call(operacoes, op) ? operacoes[op] : null;
      if (!funcao) {
        responder(id, false, "operação desconhecida");
        return Promise.resolve();
      }
      var av = avplay();
      if (!av) {
        responder(id, false, "AVPlay indisponível");
        return Promise.resolve();
      }
      return new Promise(function (resolve) { resolve(funcao(av, args)); }).then(
        function (valor) { responder(id, true, valor === undefined ? null : valor); },
        function (erro) { responder(id, false, curto(erro)); }
      );
    }

    // Ponto de entrada do evento `message` da janela da casca. Retorna uma Promise que termina
    // quando a resposta foi enviada (ou na hora, se a mensagem foi ignorada).
    function receber(evento) {
      if (!ehObjeto(evento) || evento.origin !== origem) return Promise.resolve();
      var esperada = janelaSite();
      if (!esperada || evento.source !== esperada) return Promise.resolve();
      var dados = evento.data;
      if (!ehObjeto(dados) || typeof dados.cebola !== "string") return Promise.resolve();

      if (dados.cebola === "ola") {
        parar();
        var encerramento = config.streaming ? config.streaming.call("shutdown", {}) : Promise.resolve();
        return encerramento.catch(function () {}).then(function () {
          enviar({ cebola: "casca", versao: VERSAO, avplay: avplay() !== null, streaming: !!config.streaming });
        });
      }
      if (dados.cebola === "sair") {
        try { sair(); } catch (erro) { /* sem o objeto tizen (fora da TV) */ }
        return Promise.resolve();
      }
      if (dados.cebola === "avplay") {
        // Sem id numérico não há a quem responder; ignora em vez de inventar um id.
        if (!ehNumero(dados.id)) return Promise.resolve();
        if (typeof dados.op !== "string") {
          responder(dados.id, false, "operação inválida");
          return Promise.resolve();
        }
        return executar(dados.id, dados.op, ehObjeto(dados.args) ? dados.args : {});
      }
      return Promise.resolve();
    }

    // Recomendação da Samsung para app que vai para segundo plano: suspender libera o decoder
    // e restaurar retoma o vídeo de onde estava.
    function suspender() {
      var av = avplay();
      if (!av) return;
      try { av.suspend(); } catch (erro) { /* nada aberto */ }
    }

    function restaurar() {
      var av = avplay();
      if (!av) return;
      try { av.restore(); } catch (erro) { /* nada a restaurar */ }
    }

    return { receber: receber, parar: parar, suspender: suspender, restaurar: restaurar };
  }

  var api = { criarPonte: criarPonte, ORIGEM_SITE: ORIGEM_SITE, VERSAO: VERSAO };
  var raiz = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : {});
  raiz.CebolaPonte = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

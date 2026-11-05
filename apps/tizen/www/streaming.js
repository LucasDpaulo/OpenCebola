/* Local shell only. The remote page never receives the control token. */
(function (root) {
  'use strict';
  var base = 'http://127.0.0.1:2713';
  var token = null, starting = null, timer = null, foreground = true;
  function request(route, args, timeout) {
    var controller = new AbortController();
    var deadline = setTimeout(function () { controller.abort(); }, timeout || 5000);
    return fetch(base + route, {
      method: args ? 'POST' : 'GET', cache: 'no-store', signal: controller.signal,
      headers: args ? { 'Content-Type': 'application/json', 'X-Cebola-Token': token } : {},
      body: args ? JSON.stringify(args) : undefined
    }).then(function (response) {
      if (!response.ok) {
        // O motor manda o motivo (sem resposta, lento, memória); antes ele se perdia aqui.
        return response.json().catch(function () { return {}; }).then(function (body) {
          throw new Error(typeof body.error === 'string' ? body.error : 'O motor local da TV não respondeu.');
        });
      }
      return response.json();
    }).finally(function () { clearTimeout(deadline); });
  }
  function probe() {
    return request('/hello').then(function (hello) {
      if (hello.backend !== 'cebola-tizen-enginefs-v1' || !/^[a-f0-9]{64}$/.test(hello.token)) throw new Error('Motor da TV incompatível.');
      token = hello.token;
    });
  }
  function launch() {
    var id = 'CEBOLA0001.Streaming';
    var wrt = root.CebolaWrtService;
    if (wrt && typeof wrt.startService === 'function') return Promise.resolve(wrt.startService(id));
    return new Promise(function (resolve, reject) {
      if (!root.tizen || !root.tizen.application) return reject(new Error('Serviço nativo indisponível nesta TV.'));
      var timer = setTimeout(function () { reject(new Error('A TV não iniciou o serviço.')); }, 5000);
      root.tizen.application.launch(id, function () { clearTimeout(timer); resolve(); }, function () {
        clearTimeout(timer); reject(new Error('A TV não iniciou o serviço.'));
      });
    });
  }
  function ready() {
    if (token) return Promise.resolve();
    if (!starting) starting = probe().catch(function () {
      return launch().then(function () {
        var attempts = 0;
        function retry() {
          return probe().catch(function (error) {
            // Na QN55QEF1A o serviço leva ~4,4 s para escutar a frio (motor de 6 MB numa CPU fraca);
            // 10 tentativas ficavam no limite e a primeira abertura falhava. Até ~15 s.
            if (++attempts >= 30) throw error;
            return new Promise(function (resolve) { setTimeout(resolve, 500); }).then(retry);
          });
        }
        return retry();
      });
    }).finally(function () { starting = null; });
    return starting;
  }
  function heartbeat() {
    clearInterval(timer);
    timer = setInterval(function () { if (token) request('/capabilities', {}).catch(function () {}); }, 10000);
  }
  var allowed = ['capabilities', 'prepare', 'cancel', 'stop', 'stats', 'cacheInfo', 'clearCache', 'shutdown'];
  root.CebolaStreaming = {
    call: function (op, args) {
      if (allowed.indexOf(op) < 0) return Promise.reject(new Error('Operação inválida.'));
      if (op === 'shutdown' && !token && !starting) return Promise.resolve();
      if (op === 'prepare' && !foreground) return Promise.reject(new Error('Aplicativo em segundo plano.'));
      return ready().then(function () {
        if (op === 'prepare' && !foreground) throw new Error('Aplicativo em segundo plano.');
        if (op === 'prepare') heartbeat();
        return request('/' + op, args || {}, op === 'prepare' ? 65000 : 5000);
      });
    },
    background: function () {
      foreground = false;
      clearInterval(timer);
      if (token) request('/shutdown', {}).catch(function () {});
    },
    foreground: function () { foreground = true; }
  };
})(typeof window === 'undefined' ? globalThis : window);

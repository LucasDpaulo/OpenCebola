/* Tizen Web Service lifecycle (CommonJS, independent of the browser). */
'use strict';
var service;
module.exports.onStart = function () {
  if (service) return;
  try {
    service = require('./streaming-core.cjs').createService(require('./engine-core.cjs'));
    service.start().catch(function () { service = null; });
  } catch (_) { service = null; }
};
module.exports.onExit = function () {
  if (service) service.close().catch(function () {});
};
module.exports.onStop = module.exports.onExit;

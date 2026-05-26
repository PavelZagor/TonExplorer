'use strict';

const express = require('express');

const healthRoute = require('./health');
const tokenRoute = require('./token');
const developerRoute = require('./developer');
const { infoHandler: tradingInfo, tradesHandler: tradingTrades, candlesHandler: tradingCandles } = require('./trading');
const { makeSearchHandler } = require('./search');

function buildRoutes(ctx) {
  const router = express.Router();

  router.get('/health', healthRoute(ctx));
  router.get('/token/:address', tokenRoute(ctx));
  router.get('/developer/:address', developerRoute(ctx));
  router.get('/trading/:jetton/info',    tradingInfo(ctx));
  router.get('/trading/:jetton/trades',  tradingTrades(ctx));
  router.get('/trading/:jetton/candles', tradingCandles(ctx));
  router.get('/search', makeSearchHandler(ctx));

  return router;
}

module.exports = buildRoutes;

'use strict';

const express = require('express');

const healthRoute = require('./health');
const tokenRoute = require('./token');
const developerRoute = require('./developer');

function buildRoutes(ctx) {
  const router = express.Router();

  router.get('/health', healthRoute(ctx));
  router.get('/token/:address', tokenRoute(ctx));
  router.get('/developer/:address', developerRoute(ctx));

  return router;
}

module.exports = buildRoutes;

'use strict';
const { NissanPlatform, PLUGIN, PLATFORM } = require('./lib/platform');
module.exports = (api) => api.registerPlatform(PLUGIN, PLATFORM, NissanPlatform);

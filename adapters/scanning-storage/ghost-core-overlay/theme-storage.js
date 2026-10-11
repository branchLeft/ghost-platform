'use strict';

// Replaces Ghost's services/themes/theme-storage.js in the image. The
// Dockerfile first checks the upstream file's hash, then renames it to
// theme-storage.upstream.js, so this file wraps the real class rather than
// carrying a copy of it. README.md in this directory says why.
const GhostErrors = require('@tryghost/errors');

const UpstreamThemeStorage = require('./theme-storage.upstream');
const adapterManager = require('../adapter-manager').default;
const { defineGatedThemeStorage } = require('../../adapters/storage/theme-gate');

module.exports = defineGatedThemeStorage(UpstreamThemeStorage, { adapterManager, GhostErrors });

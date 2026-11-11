'use strict';
// Runs INSIDE the built Ghost image (`node importer-in-image.cjs`, as the
// image's own user). It loads Ghost's real import manager, whose handlers and
// content-file importers are the ones a content import uses, with the scanning
// decorator configured for images, media and files, and pushes one fixture per
// kind through them: handler.loadFile, importer.preProcess, importer.doImport.
// It prints one JSON line of facts; the image test asserts on them.
//
// Fixtures are read from FIXTURE_DIR (a read-only mount). Nothing here reaches
// the network or a database.
const fs = require('node:fs');
const path = require('node:path');

const CORE = '/var/lib/ghost/current/core/server';
const FIXTURE_DIR = process.env.FIXTURE_DIR || '/fixtures';

// Ghost's real handlers read the stores at require time, so the content
// directory (and the log folder Ghost's logger looks for) has to exist before
// the import manager is loaded.
fs.mkdirSync(path.join(process.env.paths__contentPath, 'logs'), { recursive: true });

const importManager = require(`${CORE}/data/importer/import-manager`);
const adapterManager = require(`${CORE}/services/adapter-manager`).default;

const KINDS = [
  { type: 'images', fixture: 'photo.png', entry: 'content/images/2019/01/photo.png' },
  { type: 'media', fixture: 'clip.mp4', entry: 'content/media/2019/01/clip.mp4' },
  { type: 'files', fixture: 'report.pdf', entry: 'content/files/2019/01/report.pdf' },
];

async function importOne({ type, fixture, entry }) {
  const handler = importManager.handlers.find((h) => h.type === type);
  const importer = importManager.importers.find((i) => i.type === type);
  const store = adapterManager.getAdapter(`storage:${type}`);
  const source = path.join(FIXTURE_DIR, fixture);

  const loaded = await handler.loadFile([{ name: entry, path: source }]);
  const reference = `/${entry}`;
  const importData = {
    [type]: loaded,
    data: {
      data: {
        posts: [{ markdown: `![ref](${reference})`, html: `<a href="${reference}">ref</a>` }],
      },
    },
  };
  importer.preProcess(importData);
  const results = await importer.doImport(importData[type]);

  const [result] = results;
  const relative = path.relative(store.staticFileURLPrefix, result.newPath.replace(/^\//, ''));
  const storedFile = path.join(store.storagePath, relative);
  const post = importData.data.data.posts[0];
  return {
    type,
    storeClass: store.constructor.name,
    handlerStoreClass: handler.storage ? handler.storage.constructor.name : null,
    staticFileURLPrefix: store.staticFileURLPrefix,
    originalPath: result.originalPath,
    newPath: result.newPath,
    stored: result.stored,
    postMarkdown: post.markdown,
    postHtml: post.html,
    storedFileExists: fs.existsSync(storedFile),
    storedBytesMatch:
      fs.existsSync(storedFile) && fs.readFileSync(storedFile).equals(fs.readFileSync(source)),
  };
}

(async () => {
  const facts = [];
  for (const kind of KINDS) {
    facts.push(await importOne(kind));
  }
  process.stdout.write(`${JSON.stringify(facts)}\n`);
  // Ghost's job manager and loggers can hold the loop open.
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});

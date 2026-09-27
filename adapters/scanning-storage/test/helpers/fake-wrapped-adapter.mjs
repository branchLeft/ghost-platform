import { FakeStorageBase } from './fake-storage-base.mjs';

// A test double standing in for a real Ghost storage adapter (local or S3).
// Tracks every save()/saveRaw() as a tiny virtual filesystem (path ->
// buffer), so exists()/read() answer from real state exactly as a real
// adapter's would. The hold branch depends on that: nothing must be
// observable through this adapter until something has actually written to
// it -- a canned true/false here would hide exactly the bug this decorator
// exists to avoid.
//
// `existsResult`/`readResult` in config still override the real-state
// answer when a test wants to force one, independent of what has or hasn't
// been written -- used by tests about pure delegation, not about hold.
export class FakeWrappedAdapter extends FakeStorageBase {
  constructor(config = {}) {
    super();
    this.config = config;
    this.storagePath = config.storagePath ?? 'fake-storage-path';
    this.saved = [];
    this.savedRaw = [];
    this.deleted = [];
    this.files = new Map();
  }

  #key(targetPath) {
    return String(targetPath).replace(/^\/+/, '');
  }

  async save(file, targetDir) {
    this.saved.push({ file, targetDir });
    const targetPath = `${targetDir ?? ''}/${file.name}`;
    this.files.set(this.#key(targetPath), Buffer.from(`saved:${file.name}`));
    return `https://example.test/content/images/${targetPath}`;
  }

  async saveRaw(buffer, targetPath) {
    this.savedRaw.push({ buffer, targetPath });
    this.files.set(this.#key(targetPath), buffer);
    return `https://example.test/content/images/${targetPath}`;
  }

  async exists(fileName, targetDir) {
    if (this.config.existsResult !== undefined) return this.config.existsResult;
    const key = targetDir !== undefined ? `${targetDir}/${fileName}` : fileName;
    return this.files.has(this.#key(key));
  }

  async read(options) {
    if (this.config.readResult !== undefined) return this.config.readResult;
    const key = options && typeof options === 'object' ? options.path : options;
    const found = this.files.get(this.#key(key ?? ''));
    if (found === undefined) {
      const err = new Error('Could not find image.');
      err.code = 'ENOENT';
      throw err;
    }
    return found;
  }

  async delete(fileName, targetDir) {
    this.deleted.push({ fileName, targetDir });
    const key = targetDir !== undefined ? `${targetDir}/${fileName}` : fileName;
    this.files.delete(this.#key(key));
  }

  urlToPath(url) {
    return url.replace('https://example.test/content/images/', '');
  }

  // A real serve() middleware answers the request directly on a hit; it
  // does not call next(). Marking the response lets a test tell "the real
  // middleware ran" apart from a route that fell through to something else.
  serve() {
    return (req, res) => {
      res.served = true;
    };
  }
}

export function makeLoadWrappedAdapterClass(classesByName) {
  return function loadWrappedAdapterClass(name) {
    const AdapterClass = classesByName[name];
    if (!AdapterClass) {
      throw new Error(`no such wrapped adapter: ${name}`);
    }
    return AdapterClass;
  };
}

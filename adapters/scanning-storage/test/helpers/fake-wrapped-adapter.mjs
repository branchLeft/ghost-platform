import { FakeStorageBase } from './fake-storage-base.mjs';

// A test double for a real Ghost storage adapter. Tracks every
// save()/saveRaw() as a virtual filesystem so exists()/read() answer from
// real state, never a canned true/false, which would hide the bug the hold
// branch exists to catch. See fake-wrapped-adapter.md#fakewrappedadapter.
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
    // Like a real adapter, which dates the folder itself when none is given.
    const dir = targetDir ?? this.config.defaultTargetDir;
    let targetPath = `${dir ?? ''}/${file.name}`;
    // Like a real adapter's save(): a taken name gets a new one, so a
    // replace that fails to overwrite is visible as a second object.
    if (this.config.uniqueNames) {
      const dot = file.name.lastIndexOf('.');
      const stem = dot < 0 ? file.name : file.name.slice(0, dot);
      const ext = dot < 0 ? '' : file.name.slice(dot);
      for (let n = 1; this.files.has(this.#key(targetPath)); n += 1) {
        targetPath = `${dir ?? ''}/${stem}-${n}${ext}`;
      }
    }
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
    // The storage gateway refuses every delete.
    if (this.config.refuseDelete) {
      throw new Error('AccessDenied: DeleteObject is refused');
    }
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

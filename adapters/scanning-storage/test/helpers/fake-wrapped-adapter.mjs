import { FakeStorageBase } from './fake-storage-base.mjs';

// A test double standing in for a real Ghost storage adapter (local or S3).
// Records every call it receives so a test can assert the decorator either
// reached it (allow) or never did (refuse).
export class FakeWrappedAdapter extends FakeStorageBase {
  constructor(config = {}) {
    super();
    this.config = config;
    this.storagePath = config.storagePath ?? 'fake-storage-path';
    this.saved = [];
    this.savedRaw = [];
    this.deleted = [];
  }

  async save(file, targetDir) {
    this.saved.push({ file, targetDir });
    return `https://example.test/content/images/${targetDir ?? ''}/${file.name}`;
  }

  async saveRaw(buffer, targetPath) {
    this.savedRaw.push({ buffer, targetPath });
    return `https://example.test/content/images/${targetPath}`;
  }

  async exists(fileName, targetDir) {
    return this.config.existsResult ?? false;
  }

  async read() {
    return this.config.readResult ?? Buffer.from('served-bytes');
  }

  async delete(fileName, targetDir) {
    this.deleted.push({ fileName, targetDir });
  }

  urlToPath(url) {
    return url.replace('https://example.test/content/images/', '');
  }

  serve() {
    return (req, res, next) => next();
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

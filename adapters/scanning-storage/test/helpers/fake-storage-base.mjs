import path from 'node:path';

// Mirrors the shape of Ghost's real ghost-storage-base StorageBase closely
// enough to prove the decorator's own contract with the adapter manager
// (requiredFns present, constructor chain intact) without installing
// Ghost's package tree. The one file-path helper it carries is a port of the
// real base class's getUniqueFileName, because the decorator overrides it
// and Ghost's content importer depends on it: sanitise the name, then take
// the first free name in the directory by asking exists().
export class FakeStorageBase {
  constructor() {
    Object.defineProperty(this, 'requiredFns', {
      value: Object.freeze(['exists', 'save', 'serve', 'delete', 'read']),
      writable: false,
    });
  }

  getSanitizedFileName(fileName) {
    return fileName.replace(/[^\w@.]/gi, '-');
  }

  async generateUnique(dir, name, ext, index) {
    const append = index ? `-${index}` : '';
    const filename = ext ? name + append + ext : name + append;
    return (await this.exists(filename, dir))
      ? this.generateUnique(dir, name, ext, index + 1)
      : path.join(dir, filename);
  }

  getUniqueFileName(file, targetDir) {
    const ext = path.extname(file.name);
    if (!ext.match(/\.\d+$/)) {
      const name = this.getSanitizedFileName(path.basename(file.name, ext));
      return this.generateUnique(targetDir, name, ext, 0);
    }
    const name = this.getSanitizedFileName(path.basename(file.name));
    return this.generateUnique(targetDir, name, null, 0);
  }
}

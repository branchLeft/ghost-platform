import fs from 'node:fs/promises';
import path from 'node:path';
import { FakeStorageBase } from './fake-storage-base.mjs';

// Stands in for the object-storage adapter the paid tiers run: whatever it
// is asked to write lands as a file under config.bucketDir, so a directory
// is the live bucket and anything a backup reads from that bucket can be
// listed with the filesystem. Nothing else is written there.
export class DirectoryBucketAdapter extends FakeStorageBase {
  constructor(config = {}) {
    super();
    this.config = config;
    this.bucketDir = config.bucketDir;
    this.storagePath = config.storagePath ?? 'content/media';
  }

  #file(key) {
    return path.join(this.bucketDir, String(key).replace(/^\/+/, ''));
  }

  #url(key) {
    return `https://cdn.example.test/${String(key).replace(/^\/+/, '')}`;
  }

  getTargetDir(baseDir) {
    return `${baseDir}/2026/11`;
  }

  async #write(key, buffer) {
    await fs.mkdir(path.dirname(this.#file(key)), { recursive: true });
    await fs.writeFile(this.#file(key), buffer);
    return this.#url(key);
  }

  async save(file, targetDir) {
    const dir = targetDir ?? this.getTargetDir(this.storagePath);
    return this.#write(`${dir}/${file.name}`, await fs.readFile(file.path));
  }

  async saveRaw(buffer, targetPath) {
    return this.#write(targetPath, buffer);
  }

  async exists(fileName, targetDir) {
    const key = targetDir ? `${targetDir}/${fileName}` : fileName;
    return fs
      .access(this.#file(key))
      .then(() => true)
      .catch(() => false);
  }

  async read(options) {
    const key = options && typeof options === 'object' ? options.path : options;
    return fs.readFile(this.#file(key));
  }

  async delete(fileName, targetDir) {
    const key = targetDir ? `${targetDir}/${fileName}` : fileName;
    await fs.rm(this.#file(key), { force: true });
  }

  urlToPath(url) {
    return url.replace('https://cdn.example.test/', '');
  }

  serve() {
    return () => {};
  }
}

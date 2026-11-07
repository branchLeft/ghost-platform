import fs from 'node:fs/promises';
import { FakeStorageBase } from './fake-storage-base.mjs';

// Stands in for Ghost 6.55.0's S3Storage in the one respect content-type.md
// is about: save() sends ContentType: file.type, saveRaw(buffer, targetPath)
// sends none, and both go through a public-input command on `this.client`
// (the AWS SDK's Command classes keep their input as `command.input`). The
// bucket behind the client stores what S3 stores: the type the request
// named, else application/octet-stream.
export class FakePutObjectCommand {
  constructor(input) {
    this.input = input;
  }
}

export class FakeS3Bucket {
  constructor() {
    this.objects = new Map();
  }

  async send(command) {
    const { Key, Body, ContentType } = command.input;
    this.objects.set(Key, { body: Body, contentType: ContentType ?? 'application/octet-stream' });
    return {};
  }

  // The Content-Type header a browser would be sent for this key.
  servedContentType(key) {
    const found = this.objects.get(key);
    return found ? found.contentType : undefined;
  }
}

export class FakeS3Storage extends FakeStorageBase {
  constructor(config = {}) {
    super();
    this.storagePath = config.storagePath ?? 'content/images';
    this.staticFileURLPrefix = this.storagePath;
    this.bucket = new FakeS3Bucket();
    // A Ghost bump that renamed or hid the client is simulated by omitting it.
    this.client = config.withoutClient ? undefined : this.bucket;
  }

  async exists(fileName, targetDir) {
    const relativePath = targetDir ? `${targetDir}/${fileName}` : fileName;
    return this.bucket.objects.has(`${this.storagePath}/${relativePath}`);
  }

  async save(file, targetDir) {
    const dir = targetDir ?? 'content/images/2026/09';
    const relativePath = `${dir}/${file.name}`;
    const body = await fs.readFile(file.path);
    await this.client.send(
      new FakePutObjectCommand({
        Bucket: 'bucket',
        Key: relativePath,
        Body: body,
        ContentType: file.type,
      })
    );
    return `https://cdn.example.test/${relativePath}`;
  }

  async saveRaw(buffer, targetPath) {
    await this.client.send(
      new FakePutObjectCommand({ Bucket: 'bucket', Key: targetPath, Body: buffer })
    );
    return `https://cdn.example.test/${targetPath}`;
  }

  async read() {
    throw new Error('not used');
  }

  async delete() {}

  urlToPath(url) {
    return url.replace('https://cdn.example.test/', '');
  }

  serve() {
    return () => {};
  }
}

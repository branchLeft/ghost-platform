// Mirrors the shape of Ghost's real ghost-storage-base StorageBase closely
// enough to prove the decorator's own contract with the adapter manager
// (requiredFns present, constructor chain intact) without installing
// Ghost's package tree. It carries none of the real base class's file-path
// helpers, because the decorator never calls them -- it delegates every
// concrete operation to whatever it wraps.
export class FakeStorageBase {
  constructor() {
    Object.defineProperty(this, 'requiredFns', {
      value: Object.freeze(['exists', 'save', 'serve', 'delete', 'read']),
      writable: false,
    });
  }
}

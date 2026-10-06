import * as pg14 from './pg14.js';

// One committed catalog snapshot per supported server major version.
export interface CatalogShape {
  COLUMNS: readonly string[];
  PRIVILEGES: Readonly<Record<string, readonly string[]>>;
}

export const SNAPSHOTS: Record<number, CatalogShape> = { 14: pg14 };

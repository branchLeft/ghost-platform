import * as pg14 from './pg14.js';
import * as pg17 from './pg17.js';

// One committed catalog snapshot per supported server major version. Against
// PostgreSQL 14, version 17 adds, among locale and statistics columns that
// bear no privilege: membership options (M02), parameter ACLs (M16),
// publication namespaces (M23, and M25 as a catalog with an oid), login event
// triggers (M22 refuses any event trigger), subscription options (M23 refuses
// any subscription) and the MAINTAIN privilege (M06, through aclexplode).
export interface CatalogShape {
  COLUMNS: readonly string[];
  PRIVILEGES: Readonly<Record<string, readonly string[]>>;
}

export const SNAPSHOTS: Record<number, CatalogShape> = { 14: pg14, 17: pg17 };

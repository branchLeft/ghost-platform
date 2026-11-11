import { PermanentStepError } from '../../src/index.js';
import type {
  Clock,
  ConsoleReporter,
  EntryPoint,
  ExecutePorts,
  HostEntryPoint,
  ProgressEvent,
  RecordedApproval,
  RegisterEntry,
  StateRecord,
  StateStore,
  StepRequest,
} from '../../src/index.js';

export const ENTRY: RegisterEntry = {
  tenantId: 'TENANT_ID_PLACEHOLDER',
  mediaFolder: 'MEDIA_FOLDER_PLACEHOLDER',
  mediaBucket: 'BUCKET_PLACEHOLDER',
  appHostSlot: 'SLOT_PLACEHOLDER',
  appHostPort: 20001,
  appHostUid: 20001,
  hostnames: ['host-one.example.invalid', 'host-two.example.invalid'],
};

export const APPROVAL: RecordedApproval = {
  approvalId: 'APPROVAL_ID_PLACEHOLDER',
  tenantId: ENTRY.tenantId,
  approvedAt: '2026-01-01T00:00:00Z',
  scopes: ['setup', 'web-address', 'first-deploy'],
};

/** Stands in for a process that died: not an Error a retry loop would swallow. */
export class Killed extends Error {
  constructor() {
    super('KILLED_PLACEHOLDER');
    this.name = 'Killed';
  }
}

export interface HostCall {
  readonly entryPoint: EntryPoint;
  readonly request: StepRequest;
}

export class MemoryStore implements StateStore {
  readonly records: StateRecord[] = [];
  failReads: Error | undefined;
  failAppendsFrom: number | undefined;
  failOnEvent: string | undefined;

  async readAll(): Promise<readonly StateRecord[]> {
    if (this.failReads !== undefined) throw this.failReads;
    return [...this.records];
  }

  async append(record: StateRecord): Promise<void> {
    if (this.failAppendsFrom !== undefined && this.records.length >= this.failAppendsFrom) {
      throw new Killed();
    }
    if (this.failOnEvent !== undefined && record.event === this.failOnEvent) {
      throw new Error('DISK_FULL_PLACEHOLDER');
    }
    this.records.push(record);
  }

  completeKeys(): string[] {
    return this.records.filter((r) => r.event === 'complete').map((r) => r.key ?? '');
  }
}

export class World {
  approval: RecordedApproval | undefined = APPROVAL;
  entry: RegisterEntry = ENTRY;
  readonly state = new MemoryStore();
  readonly calls: HostCall[] = [];
  readonly events: ProgressEvent[] = [];
  /** For each event, the step keys durably complete at the moment it was reported. */
  readonly completeAtReport: string[][] = [];
  readonly sleeps: number[] = [];
  /** Per step key: how many leading calls throw. */
  failFirst = new Map<string, number>();
  failAlways = new Set<string>();
  permanent = new Set<string>();
  consoleFails = false;
  /** Runs after each host call completes, with the call count so far. */
  afterCall: ((count: number) => void) | undefined;
  /** Runs at the start of each host call, before it has any effect. */
  beforeCall: ((request: StepRequest) => void) | undefined;
  private clockTick = 0;

  private host(entryPoint: EntryPoint): HostEntryPoint {
    return {
      run: async (request) => {
        this.beforeCall?.(request);
        this.calls.push({ entryPoint, request });
        const seen = this.calls.filter((c) => c.request.key === request.key).length;
        if (this.permanent.has(request.key)) {
          throw new PermanentStepError('PERMANENT_PLACEHOLDER');
        }
        if (this.failAlways.has(request.key)) throw new Error('HOST_DOWN_PLACEHOLDER');
        if (seen <= (this.failFirst.get(request.key) ?? 0)) {
          throw new Error('HOST_BUSY_PLACEHOLDER');
        }
        this.afterCall?.(this.calls.length);
      },
    };
  }

  private reporter(): ConsoleReporter {
    return {
      report: async (event) => {
        if (this.consoleFails) throw new Error('CONSOLE_DOWN_PLACEHOLDER');
        this.events.push(event);
        this.completeAtReport.push(this.state.completeKeys());
      },
    };
  }

  private clock(): Clock {
    return {
      now: () => `2026-01-01T00:00:${String(this.clockTick++ % 60).padStart(2, '0')}Z`,
      sleep: async (ms) => {
        this.sleeps.push(ms);
      },
    };
  }

  ports(store: StateStore = this.state): ExecutePorts {
    return {
      approvals: { find: async () => this.approval },
      register: { read: async () => this.entry },
      hosts: {
        controller: this.host('controller'),
        'db-host': this.host('db-host'),
        'app-host': this.host('app-host'),
        'storage-gateway': this.host('storage-gateway'),
        'source-host': this.host('source-host'),
        edge: this.host('edge'),
        dns: this.host('dns'),
      },
      state: store,
      console: this.reporter(),
      clock: this.clock(),
    };
  }

  callCount(key: string): number {
    return this.calls.filter((c) => c.request.key === key).length;
  }
}

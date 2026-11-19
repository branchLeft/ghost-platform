import type { StepResult } from '../../../src/bumpStateMachine.js';
import type { Colour, ColourHost } from '../../../src/colourSwitch.js';

export type Method = 'prepare' | 'runningColours' | 'stop' | 'start';

/**
 * A fault on the `nth` call (from 1) of one method. `throw` rejects; `fail`
 * returns `{ ok: false }`; `linger` makes a stop return while the process is
 * still alive, the one lie a host can tell that matters here.
 */
export interface Fault {
  method: Method;
  nth: number;
  mode: 'throw' | 'fail' | 'linger';
}

export interface FakeOptions {
  fault?: Fault;
  /** Colours whose start always leaves a process up and reports not healthy: a broken image. */
  brokenStart?: readonly Colour[];
}

export interface Call {
  method: Method;
  colour?: Colour;
  image?: string;
  /** The colours with a process when the call was made. */
  aliveBefore: Colour[];
}

/**
 * Models the host's Ghost processes for one tenant. A process exists from the
 * moment `start` is called, not when it turns healthy, because Ghost runs its
 * boot work (resumeInterruptedSends) as it starts. `peak` is the most
 * processes alive at once; `overlapStarts` lists every start made while the
 * other colour had a process. Either being non-empty is the duplicate-send
 * window this control exists to close.
 */
export class FakeColourHost implements ColourHost {
  readonly alive = new Set<Colour>();
  readonly calls: Call[] = [];
  readonly overlapStarts: string[] = [];
  peak = 0;
  private readonly counts = new Map<Method, number>();

  constructor(
    initial: readonly Colour[],
    private readonly options: FakeOptions = {}
  ) {
    for (const colour of initial) this.alive.add(colour);
    this.peak = this.alive.size;
  }

  /** Calls per method so far. */
  count(method: Method): number {
    return this.counts.get(method) ?? 0;
  }

  private enter(method: Method, colour?: Colour, image?: string): Fault['mode'] | undefined {
    const nth = this.count(method) + 1;
    this.counts.set(method, nth);
    this.calls.push({
      method,
      ...(colour === undefined ? {} : { colour }),
      ...(image === undefined ? {} : { image }),
      aliveBefore: [...this.alive].sort(),
    });
    const fault = this.options.fault;
    return fault !== undefined && fault.method === method && fault.nth === nth
      ? fault.mode
      : undefined;
  }

  prepare(colour: Colour, image: string): Promise<StepResult> {
    const mode = this.enter('prepare', colour, image);
    if (mode === 'throw') return Promise.reject(new Error('prepare threw'));
    if (mode === 'fail') return Promise.resolve({ ok: false, reason: 'migration check failed' });
    return Promise.resolve({ ok: true });
  }

  runningColours(): Promise<readonly Colour[]> {
    const mode = this.enter('runningColours');
    if (mode === 'throw') return Promise.reject(new Error('host unreadable'));
    return Promise.resolve([...this.alive].sort());
  }

  stop(colour: Colour): Promise<void> {
    const mode = this.enter('stop', colour);
    if (mode === 'throw') return Promise.reject(new Error('stop threw'));
    if (mode !== 'linger') this.alive.delete(colour);
    return Promise.resolve();
  }

  start(colour: Colour, image: string): Promise<StepResult> {
    const mode = this.enter('start', colour, image);
    const rival: Colour = colour === 'a' ? 'b' : 'a';
    if (this.alive.has(rival)) this.overlapStarts.push(`${colour} started while ${rival} alive`);
    this.alive.add(colour);
    this.peak = Math.max(this.peak, this.alive.size);
    if (mode === 'throw') return Promise.reject(new Error('start threw'));
    if (mode === 'fail' || this.options.brokenStart?.includes(colour) === true) {
      return Promise.resolve({ ok: false, reason: `${colour} never became healthy` });
    }
    return Promise.resolve({ ok: true });
  }

  /** True when no instant had two processes and no start overlapped one. */
  neverTwo(): boolean {
    return this.peak <= 1 && this.overlapStarts.length === 0;
  }
}

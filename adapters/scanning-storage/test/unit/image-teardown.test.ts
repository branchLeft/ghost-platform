// The image tests' teardown proof (test-support/image-harness.mjs): a container
// is removed with its anonymous volumes and the removal is read back, a
// labelled leftover is found, and a teardown that fails fails the suite's last
// test. A fake `docker` on PATH stands in for the engine, so this needs no
// Docker and runs on every pull request.
//
// The fake follows Docker's rule that matters here: `docker rm` removes a
// container's anonymous volumes (not a named one) only when given `-v`. Deleting `-v` from
// `removeContainerProven` turns "removes the container and its anonymous
// volumes" red, with the volume named in the failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertNothingLeft,
  labelArgs,
  removeContainerProven,
  teardownOnce,
} from '../../../../test-support/image-harness.mjs';

const ANON_A = 'a'.repeat(64);
const ANON_B = 'b'.repeat(64);

const FAKE_DOCKER = `#!/bin/sh
state="$FAKE_DOCKER_STATE"
case "$1" in
  inspect)
    if [ -f "$state/containers/$4" ]; then cat "$state/containers/$4"; exit 0; fi
    echo "Error: No such object: $4" >&2; exit 1 ;;
  container)
    if [ -f "$state/containers/$3" ]; then exit 0; fi
    echo "Error: No such container: $3" >&2; exit 1 ;;
  volume)
    if [ "$2" = inspect ]; then
      if [ -f "$state/volumes/$3" ]; then exit 0; fi
      echo "Error: No such volume: $3" >&2; exit 1
    fi
    cat "$state/labelled-volumes" 2>/dev/null; exit 0 ;;
  network) cat "$state/labelled-networks" 2>/dev/null; exit 0 ;;
  ps) cat "$state/labelled-containers" 2>/dev/null; exit 0 ;;
  rm)
    name=""; withv=no
    for a in "$@"; do
      case "$a" in rm|-f) ;; -v) withv=yes ;; *) name="$a" ;; esac
    done
    if [ -f "$state/containers/$name" ]; then
      if [ "$withv" = yes ] && [ "$FAKE_DOCKER_IGNORE_V" != 1 ]; then
        while read -r v; do
          if printf '%s' "$v" | grep -Eq '^[0-9a-f]{64}$'; then rm -f "$state/volumes/$v"; fi
        done < "$state/containers/$name"
      fi
      rm -f "$state/containers/$name"
    fi
    exit 0 ;;
esac
echo "fake docker: unhandled $*" >&2; exit 2
`;

let dir: string;
let savedPath: string | undefined;

function addContainer(name: string, volumes: string[]): void {
  fs.writeFileSync(path.join(dir, 'containers', name), volumes.map((v) => `${v}\n`).join(''));
  for (const v of volumes) fs.writeFileSync(path.join(dir, 'volumes', v), '');
}

function exists(kind: 'containers' | 'volumes', name: string): boolean {
  return fs.existsSync(path.join(dir, kind, name));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-state-'));
  fs.mkdirSync(path.join(dir, 'containers'));
  fs.mkdirSync(path.join(dir, 'volumes'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'docker'), FAKE_DOCKER, { mode: 0o755 });
  savedPath = process.env.PATH;
  process.env.PATH = `${path.join(dir, 'bin')}${path.delimiter}${savedPath ?? ''}`;
  process.env.FAKE_DOCKER_STATE = dir;
  delete process.env.FAKE_DOCKER_IGNORE_V;
});

afterEach(() => {
  process.env.PATH = savedPath;
  delete process.env.FAKE_DOCKER_STATE;
  delete process.env.FAKE_DOCKER_IGNORE_V;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('labelArgs', () => {
  it('names the component and this process', () => {
    expect(labelArgs('some-test')).toEqual([
      '--label',
      'branchleft.component=some-test',
      '--label',
      `branchleft.run=${process.pid}`,
    ]);
  });
});

describe('removeContainerProven', () => {
  it('removes the container and its anonymous volumes, and leaves a named volume alone', () => {
    addContainer('ghost-1', [ANON_A, ANON_B, 'a-named-volume']);
    removeContainerProven('ghost-1');
    expect(exists('containers', 'ghost-1')).toBe(false);
    expect(exists('volumes', ANON_A)).toBe(false);
    expect(exists('volumes', ANON_B)).toBe(false);
    expect(exists('volumes', 'a-named-volume')).toBe(true);
  });

  it('names the volume when the engine leaves one behind', () => {
    process.env.FAKE_DOCKER_IGNORE_V = '1';
    addContainer('ghost-2', [ANON_A]);
    expect(() => removeContainerProven('ghost-2')).toThrow(`volume ${ANON_A}`);
  });

  it('has nothing to prove for a container that is already gone', () => {
    expect(() => removeContainerProven('never-existed')).not.toThrow();
  });

  it('fails when docker cannot be asked, rather than reading silence as success', () => {
    fs.writeFileSync(
      path.join(dir, 'bin', 'docker'),
      '#!/bin/sh\necho "daemon down" >&2\nexit 1\n',
      {
        mode: 0o755,
      }
    );
    expect(() => removeContainerProven('ghost-3')).toThrow('cannot inspect');
  });
});

describe('assertNothingLeft', () => {
  it('passes when nothing carries this run label', () => {
    expect(() => assertNothingLeft('some-test')).not.toThrow();
  });

  it('names a container, a network and a volume that are still there', () => {
    fs.writeFileSync(path.join(dir, 'labelled-containers'), 'scan-1\n');
    fs.writeFileSync(path.join(dir, 'labelled-networks'), 'contract-net-1\n');
    fs.writeFileSync(path.join(dir, 'labelled-volumes'), `${ANON_A}\n`);
    expect(() => assertNothingLeft('some-test')).toThrow(
      `container scan-1, network contract-net-1, volume ${ANON_A}`
    );
  });
});

describe('teardownOnce', () => {
  it('runs every part even when an earlier one fails, and names each failure', () => {
    const ran: string[] = [];
    const teardown = teardownOnce({
      first: () => {
        ran.push('first');
        throw new Error('EPERM: rmdir');
      },
      second: () => {
        ran.push('second');
      },
      third: () => {
        ran.push('third');
        throw new Error('volume left');
      },
    });
    expect(() => teardown()).toThrow(/first: EPERM: rmdir\n {2}third: volume left/);
    expect(ran).toEqual(['first', 'second', 'third']);
  });

  it('runs once: the after-hook backstop does not repeat what the last test did', () => {
    let calls = 0;
    const teardown = teardownOnce({
      only: () => {
        calls += 1;
      },
    });
    teardown();
    teardown();
    expect(calls).toBe(1);
  });
});

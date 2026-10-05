import * as pulumi from '@pulumi/pulumi';

/** A resource the component registered under Pulumi's mocks. */
export interface Created {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}

export const created: Created[] = [];

/** Runs every `GhostTenant` under Pulumi's mocks: no engine, no stack, no cloud. */
export function installMocks(): void {
  pulumi.runtime.setMocks(
    {
      newResource(args: pulumi.runtime.MockResourceArgs) {
        created.push({ type: args.type, name: args.name, inputs: args.inputs });
        return { id: `${args.name}-id`, state: { ...args.inputs } };
      },
      call() {
        return {};
      },
    },
    'ghost-tenant-test',
    'test',
    false
  );
}

/** Resolves an Output's value under mocks. */
export function unwrap<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    output.apply((value) => {
      resolve(value);
      return value;
    });
  });
}

/** Lets module-scope resolution settle before an assertion reads `created`. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

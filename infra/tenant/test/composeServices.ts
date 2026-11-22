import { load } from 'js-yaml';

export interface ComposeDocument {
  services: Record<string, Record<string, unknown> & { ports?: string[] }>;
}

/** The Ghost services, with their published ports, in the document the component outputs. */
export function ghostServices(composeFile: string): { name: string; ports: string[] }[] {
  const document = load(composeFile) as ComposeDocument;
  return Object.entries(document.services)
    .filter(([name]) => name.startsWith('ghost'))
    .map(([name, service]) => ({ name, ports: service.ports ?? [] }));
}

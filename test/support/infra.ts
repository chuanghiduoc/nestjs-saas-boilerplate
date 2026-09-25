import { inject } from 'vitest';

export type Creds = { user: string; password: string };
export type Infra = {
  pg: {
    host: string;
    port: number;
    database: string;
    owner: Creds;
    app: Creds;
    relay: Creds;
  };
  pgbouncer: { host: string; port: number };
  redis: { url: string };
};

declare module 'vitest' {
  export interface ProvidedContext {
    infra: Infra;
  }
}

export function getInfra(): Infra {
  return inject('infra');
}

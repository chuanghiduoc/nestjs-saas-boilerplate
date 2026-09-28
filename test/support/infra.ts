import { inject } from 'vitest';

export type Creds = { user: string; password: string };
export type Infra = {
  pg: {
    host: string;
    port: number;
    database: string;
    /** Id của container Postgres: test chạy lại script init bên trong container (S2-R18). */
    containerId: string;
    owner: Creds;
    app: Creds;
    relay: Creds;
    auth: Creds;
  };
  pgbouncer: { host: string; port: number };
  redis: { url: string };
  mailpit: { smtpHost: string; smtpPort: number; apiUrl: string };
};

declare module 'vitest' {
  export interface ProvidedContext {
    infra: Infra;
  }
}

export function getInfra(): Infra {
  return inject('infra');
}

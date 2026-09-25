import './core/config/all-configs.js';
import { validateAllConfigs } from './core/config/index.js';
import {
  runMigrations,
  type MigrationCommand,
} from './core/database/migrator.js';

const COMMANDS = [
  'up',
  'down',
  'status',
] as const satisfies readonly MigrationCommand[];
const isCmd = (v: string): v is MigrationCommand =>
  (COMMANDS as readonly string[]).includes(v);

async function main(): Promise<void> {
  process.env.APP_ROLE = 'migrate';
  validateAllConfigs();
  const [cmd = 'up', to] = process.argv.slice(2);
  if (!isCmd(cmd))
    throw new Error(`Unknown command "${cmd}". Use: ${COMMANDS.join(' | ')}`);
  const names = await runMigrations(cmd, { to });
  process.stdout.write(`${JSON.stringify({ cmd, migrations: names })}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});

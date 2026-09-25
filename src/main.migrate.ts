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

const HELP_FLAGS = ['--help', '-h'];
const USAGE = `Usage: main.migrate.js [${COMMANDS.join(' | ')}] [target]
  up              apply pending migrations (default)
  status          list pending migrations
  down <target>   revert down to <target> (a migration name, or 0 for all)
`;

async function main(): Promise<void> {
  // Tham số được kiểm tra trước config: `--help` và lệnh sai không cần env/DB.
  const [cmd = 'up', to] = process.argv.slice(2);
  if (HELP_FLAGS.includes(cmd)) {
    process.stdout.write(USAGE);
    return;
  }
  if (!isCmd(cmd))
    throw new Error(`Unknown command "${cmd}". Use: ${COMMANDS.join(' | ')}`);
  process.env.APP_ROLE = 'migrate';
  validateAllConfigs();
  const names = await runMigrations(cmd, { to });
  process.stdout.write(`${JSON.stringify({ cmd, migrations: names })}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});

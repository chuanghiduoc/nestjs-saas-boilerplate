import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

/** Chỉ dùng cho CLI khi tạo migration (`mikro-orm migration:create`); runtime dùng src/core/database/migrator.ts. */
export default defineConfig({
  extensions: [Migrator],
  entities: [],
  discovery: { warnWhenNoEntities: false },
  migrations: {
    path: 'dist/migrations',
    pathTs: 'src/migrations',
    glob: '**/*.{js,ts}',
    emit: 'ts',
    snapshot: false,
  },
});

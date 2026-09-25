import {
  type DynamicModule,
  Global,
  Module,
  type OnModuleInit,
} from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { type ConfigOf } from '../config/index.js';
import { registerErrorMapper } from '../errors/index.js';
import { DB_CONTEXT } from './constants.js';
import { allEntities } from './entities.js';
import { databaseConfig } from './database.config.js';
import { Db } from './db.js';
import { dbErrorMapper } from './db-error.mapper.js';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work.js';
import { OrgScope } from './org-scope.js';
import { RelayDb } from './relay-db.js';
import { tlsOptions } from './tls.js';
import { TxEm } from './tx-em.js';
import { UnitOfWork } from './unit-of-work.js';

type DbCfg = ConfigOf<typeof databaseConfig>;
type Who = (typeof DB_CONTEXT)[keyof typeof DB_CONTEXT];

function ormOptions(db: DbCfg, who: Who) {
  if (who === DB_CONTEXT.relay && !db.relayPassword)
    throw new Error(
      'DB_RELAY_PASSWORD is required when the relay connection is enabled (worker)',
    );
  const app = who === DB_CONTEXT.app;
  return {
    driver: PostgreSqlDriver,
    entities: allEntities(),
    discovery: { warnWhenNoEntities: false },
    host: app ? db.host : (db.relayHost ?? db.host),
    port: app ? db.port : (db.relayPort ?? db.port),
    dbName: db.name,
    user: app ? db.appUser : db.relayUser,
    password: app ? db.appPassword : db.relayPassword,
    pool: { min: 0, max: app ? db.poolMax : db.relayPoolMax },
    // Trộn vào options của pg.Pool (PostgreSqlConnection.mapOptions).
    driverOptions: { ssl: tlsOptions(db) },
    sessionContext: 'transaction' as const,
    debug: db.debug,
    allowGlobalContext: false,
    registerRequestContext: false,
  };
}

/**
 * Không đặt statement_timeout qua startup parameter (PgBouncer transaction mode bỏ đi);
 * timeout nằm trên role (docker/postgres/init) và `SET LOCAL` cho worker trong UnitOfWork.
 */
@Global()
@Module({})
export class DatabaseModule implements OnModuleInit {
  /** Map lỗi Postgres (constraint, RLS, serialization, timeout) sang mã lỗi chuẩn; registerErrorMapper bỏ qua lần đăng ký trùng. */
  onModuleInit(): void {
    registerErrorMapper(dbErrorMapper);
  }

  static forRoot(opts: { relay: boolean }): DynamicModule {
    const contexts = [
      MikroOrmModule.forRootAsync({
        contextName: DB_CONTEXT.app,
        inject: [databaseConfig.KEY],
        useFactory: (db: DbCfg) => ormOptions(db, DB_CONTEXT.app),
        driver: PostgreSqlDriver,
      }),
      ...(opts.relay
        ? [
            MikroOrmModule.forRootAsync({
              contextName: DB_CONTEXT.relay,
              inject: [databaseConfig.KEY],
              useFactory: (db: DbCfg) => ormOptions(db, DB_CONTEXT.relay),
              driver: PostgreSqlDriver,
            }),
          ]
        : []),
    ];
    return {
      module: DatabaseModule,
      imports: contexts,
      providers: [
        TxEm,
        Db,
        OrgScope,
        { provide: UnitOfWork, useClass: MikroOrmUnitOfWork },
        ...(opts.relay ? [RelayDb] : []),
      ],
      exports: [
        TxEm,
        Db,
        OrgScope,
        UnitOfWork,
        ...(opts.relay ? [RelayDb] : []),
      ],
    };
  }
}

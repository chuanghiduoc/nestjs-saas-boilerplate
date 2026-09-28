import {
  type DynamicModule,
  Global,
  Module,
  type OnModuleInit,
} from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { type ConfigOf, appConfig } from '../config/index.js';
import { registerErrorMapper } from '../errors/index.js';
import { httpConfig } from '../http/http.config.js';
import { DB_CONTEXT } from './constants.js';
import { allEntities } from './entities.js';
import { databaseConfig } from './database.config.js';
import { Db } from './db.js';
import { dbErrorMapper } from './db-error.mapper.js';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work.js';
import { OrgScope } from './org-scope.js';
import { CorePoolShutdown, CorePools } from './core-pools.js';
import { corePoolOptions, type CoreDriverOptions } from './pool-deadline.js';
import { RelayDb } from './relay-db.js';
import { DbStatementTimeoutCheck } from './statement-timeout-check.js';
import { tlsOptions } from './tls.js';
import { TxEm } from './tx-em.js';
import { UnitOfWork } from './unit-of-work.js';

type DbCfg = ConfigOf<typeof databaseConfig>;
type AppCfg = ConfigOf<typeof appConfig>;
type HttpCfg = ConfigOf<typeof httpConfig>;
type Who = (typeof DB_CONTEXT)[keyof typeof DB_CONTEXT];

function ormOptions(
  db: DbCfg,
  http: HttpCfg,
  process: AppCfg,
  who: Who,
  pools: CorePools,
) {
  if (who === DB_CONTEXT.relay && !db.relayPassword)
    throw new Error(
      'DB_RELAY_PASSWORD is required when the relay connection is enabled (worker)',
    );
  const app = who === DB_CONTEXT.app;
  const driverOptions: CoreDriverOptions = {
    ssl: tlsOptions(db),
    ...corePoolOptions(db, http, process.role, `core_${who}`, (c) =>
      pools.add(c),
    ),
  };
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
    // Trộn vào options của pg.Pool (PostgreSqlConnection.mapOptions); `onPoolCreated` được tách ra và gọi với pool
    // vừa tạo (PostgreSqlConnection.createKyselyDialect). S2-R67/S2-R70: hạn phía client, huỷ client không dùng lại
    // được, trả slot khi connection chết, thu hồi checkout (api).
    driverOptions,
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
    // Một registry cho mỗi app Nest (test dựng nhiều app trong một process).
    const pools = new CorePools();
    const contexts = [
      MikroOrmModule.forRootAsync({
        contextName: DB_CONTEXT.app,
        inject: [databaseConfig.KEY, httpConfig.KEY, appConfig.KEY],
        useFactory: (db: DbCfg, http: HttpCfg, process: AppCfg) =>
          ormOptions(db, http, process, DB_CONTEXT.app, pools),
        driver: PostgreSqlDriver,
      }),
      ...(opts.relay
        ? [
            MikroOrmModule.forRootAsync({
              contextName: DB_CONTEXT.relay,
              inject: [databaseConfig.KEY, httpConfig.KEY, appConfig.KEY],
              useFactory: (db: DbCfg, http: HttpCfg, process: AppCfg) =>
                ormOptions(db, http, process, DB_CONTEXT.relay, pools),
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
        { provide: CorePools, useValue: pools },
        CorePoolShutdown,
        DbStatementTimeoutCheck,
        ...(opts.relay ? [RelayDb] : []),
      ],
      exports: [
        TxEm,
        Db,
        OrgScope,
        UnitOfWork,
        CorePools,
        DbStatementTimeoutCheck,
        ...(opts.relay ? [RelayDb] : []),
      ],
    };
  }
}

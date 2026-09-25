export type Isolation = 'read committed' | 'repeatable read' | 'serializable';

export abstract class UnitOfWork {
  abstract run<T>(
    fn: () => Promise<T>,
    opts?: { isolation?: Isolation },
  ): Promise<T>;
  abstract inTransaction(): boolean;
}

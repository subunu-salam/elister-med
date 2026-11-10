import { MongoClient, type ClientSession, type Db } from "mongodb";

type G = { __mongo?: Promise<MongoClient> };
const g = globalThis as unknown as G;

function config() {
  const testUri = process.env.TEST_MONGODB_URI;
  if (testUri) return { uri: testUri, db: process.env.MONGODB_DB_TEST ?? "healthos_test" };
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set (see .env.example)");
  return { uri, db: process.env.MONGODB_DB ?? "healthos_dev" };
}

export function getClient(): Promise<MongoClient> {
  if (!g.__mongo) {
    g.__mongo = new MongoClient(config().uri, { maxPoolSize: 20 }).connect();
  }
  return g.__mongo;
}

export async function getDb(): Promise<Db> {
  return (await getClient()).db(config().db);
}

export async function closeClient(): Promise<void> {
  if (g.__mongo) {
    const c = await g.__mongo;
    g.__mongo = undefined;
    await c.close();
  }
}

export async function withTransaction<T>(fn: (s: ClientSession) => Promise<T>): Promise<T> {
  const client = await getClient();
  const session = client.startSession();
  try {
    let out!: T;
    await session.withTransaction(
      async () => {
        out = await fn(session);
      },
      { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
    );
    return out;
  } finally {
    await session.endSession();
  }
}

/** Sync Db handle (driver connects lazily). For adapters that need a Db at construction. */
export function getDbLazy(): Db {
  const { uri, db } = config();
  type L = { __mongoLazy?: MongoClient };
  const gl = globalThis as unknown as L;
  gl.__mongoLazy ??= new MongoClient(uri, { maxPoolSize: 10 });
  return gl.__mongoLazy.db(db);
}

import type {
  ClientSession, Document, Filter, FindOptions, UpdateFilter, UpdateResult, Sort,
} from "mongodb";
import { getDb } from "./client";

type WithOrg<T> = T & { orgId: string };

/** Tenant-scoped collection. Every operation is forced to the given orgId. */
export interface TenantCollection<T extends Document> {
  find(filter?: Filter<T>, opts?: FindOptions & { sort?: Sort; limit?: number; skip?: number; session?: ClientSession }): Promise<WithOrg<T>[]>;
  findOne(filter: Filter<T>, s?: ClientSession): Promise<WithOrg<T> | null>;
  insertOne(doc: T, s?: ClientSession): Promise<void>;
  updateMany(filter: Filter<T>, update: UpdateFilter<T>, s?: ClientSession): Promise<UpdateResult>;
  insertMany(docs: T[], s?: ClientSession): Promise<void>;
  deleteMany(filter: Filter<T>, s?: ClientSession): Promise<number>;
  updateOne(filter: Filter<T>, update: UpdateFilter<T>, s?: ClientSession, opts?: { upsert?: boolean }): Promise<UpdateResult>;
  findOneAndUpdate(filter: Filter<T>, update: UpdateFilter<T>, opts?: { sort?: Sort }, s?: ClientSession): Promise<WithOrg<T> | null>;
  count(filter: Filter<T>, s?: ClientSession): Promise<number>;
  aggregate<R extends Document = Document>(pipeline: Document[], s?: ClientSession): Promise<R[]>;
}

export function tenantCol<T extends Document = Document>(orgId: string, name: string): TenantCollection<T> {
  if (!orgId) throw new Error("tenantCol requires orgId");
  const col = async () => (await getDb()).collection<any>(name);
  const scope = (f: Filter<T> = {}) => ({ ...(f as object), orgId }) as Filter<any>;
  return {
    async find(filter, opts = {}) {
      return (await (await col()).find(scope(filter), opts).toArray()) as WithOrg<T>[];
    },
    async findOne(filter, s) {
      return (await (await col()).findOne(scope(filter), { session: s })) as WithOrg<T> | null;
    },
    async insertOne(doc, s) {
      await (await col()).insertOne({ ...(doc as object), orgId }, { session: s });
    },
    async updateMany(filter, update, s) {
      return (await col()).updateMany(scope(filter), update as any, { session: s });
    },
    async deleteMany(filter, s) {
      return (await (await col()).deleteMany(scope(filter), { session: s })).deletedCount;
    },
    async insertMany(docs, s) {
      if (docs.length) await (await col()).insertMany(docs.map((d) => ({ ...(d as object), orgId })), { session: s });
    },
    async updateOne(filter, update, s, opts) {
      // forbid rewriting orgId
      const u = update as any;
      for (const op of ["$set", "$setOnInsert", "$unset"]) if (u[op] && "orgId" in u[op]) delete u[op].orgId;
      return (await col()).updateOne(scope(filter), u, { session: s, upsert: opts?.upsert });
    },
    async findOneAndUpdate(filter, update, opts, s) {
      return (await (await col()).findOneAndUpdate(scope(filter), update as any, {
        sort: opts?.sort, session: s, returnDocument: "after",
      })) as WithOrg<T> | null;
    },
    async count(filter, s) {
      return (await col()).countDocuments(scope(filter), { session: s });
    },
    async aggregate(pipeline, s) {
      return (await (await col()).aggregate([{ $match: { orgId } }, ...pipeline], { session: s }).toArray()) as any;
    },
  };
}

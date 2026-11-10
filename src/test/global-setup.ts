import { MongoMemoryReplSet } from "mongodb-memory-server";

let rs: MongoMemoryReplSet | undefined;

// Tests run against an in-memory replica set (transactions need one).
// Never touches the user's Atlas cluster.
export async function setup() {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.TEST_MONGODB_URI = rs.getUri();
  process.env.FIELD_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
}
export async function teardown() {
  await rs?.stop();
}

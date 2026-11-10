/**
 * Runs the MOCK DHA eClaimLink server for local development and demos: `npm run mock:dha`.
 * Point the app at it on Insurance → DHA eClaimLink (mode "mock", base URL below). Never contacts DHA.
 */
import { startMockDha } from "../src/modules/integrations/eclaimlink/mock-server";

const port = Number(process.env.MOCK_DHA_PORT ?? 4010);
startMockDha({ port, delayMs: Number(process.env.MOCK_DHA_DELAY_MS ?? 0) }).then((m) => {
  console.log(`Mock DHA eClaimLink listening on ${m.url}`);
  console.log("  facility ID : DHA-F-0083721\n  login       : elister_test\n  password    : Mock-Only-Pass-1");
  console.log("  admin       : GET /admin/state · POST /admin/process · POST /admin/scenario {id, outcome: paid|partial|denied} · POST /admin/reset");
});

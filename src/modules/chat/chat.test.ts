import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ObjectId } from "mongodb";
import { ensureIndexes, closeClient, getDb, tenantCol } from "@/core/db";
import { newId } from "@/core/ids";
import { ctxFor } from "@/test/helpers";
import { savePhoto, getPhoto, photoVersions } from "@/modules/people/photos";
import * as chat from "./service";

const ORG = "org-chat";
const ids = { doc: newId(), doc2: newId(), rec: newId(), acc: newId(), hr: newId(), admin: newId(), pt: newId() };
const doc = ctxFor(["doctor"], ORG, ids.doc, "br1");
const doc2 = ctxFor(["doctor"], ORG, ids.doc2, "br1");
const rec = ctxFor(["receptionist"], ORG, ids.rec, "br1");
const acc = ctxFor(["accountant"], ORG, ids.acc, "br1");
const hr = ctxFor(["hr_manager"], ORG, ids.hr, "br1");
const admin = ctxFor(["org_admin"], ORG, ids.admin, "br1");
const patient = { ...ctxFor(["patient_portal_user"], ORG, ids.pt, "br1"), patientId: "p1" };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);

describe("staff chat", () => {
  beforeAll(async () => {
    await ensureIndexes();
    const db = await getDb();
    const people: [string, string, string[]][] = [[ids.doc, "Dr. Amina Khalid (synthetic)", ["doctor"]], [ids.doc2, "Dr. Omar Haddad", ["doctor"]], [ids.rec, "Sara Reception", ["receptionist"]], [ids.acc, "Ali Accounts", ["accountant"]], [ids.hr, "Huda HR", ["hr_manager"]], [ids.admin, "Admin", ["org_admin"]], [ids.pt, "Patient", ["patient_portal_user"]]];
    for (const [id, name, roles] of people) {
      await db.collection("user").insertOne({ _id: new ObjectId(id), name } as never);
      await tenantCol<any>(ORG, "memberships").insertOne({ _id: `${ORG}:${id}`, userId: id, branchId: "br1", roles, active: true });
    }
  });
  afterAll(closeClient);

  it("shows each person only the channels their role may see", async () => {
    const names = async (c: typeof doc) => (await chat.listChannels(c)).filter((x) => x.kind === "channel").map((x) => x.name);
    expect(await names(doc)).toEqual(expect.arrayContaining(["General", "Clinical team"]));
    expect(await names(doc)).not.toContain("Finance and insurance");
    expect(await names(rec)).toContain("Front desk");
    expect(await names(rec)).not.toContain("Clinical team");
    expect(await names(acc)).toContain("Finance and insurance");
    expect((await names(admin)).length).toBe(4);
  });

  it("keeps patients out completely", async () => {
    await expect(chat.listChannels(patient)).rejects.toThrow(/staff only/);
    await expect(chat.directory(patient)).rejects.toThrow(/staff only/);
    expect(await chat.unreadTotal(patient)).toBe(0);
  });

  it("will not let someone read or post in a channel their role cannot see", async () => {
    const finance = (await chat.listChannels(acc)).find((c) => c.name === "Finance and insurance")!;
    await expect(chat.getMessages(doc, finance._id)).rejects.toThrow(/not found/i);
    await expect(chat.sendMessage(doc, finance._id, "hi", "x")).rejects.toThrow(/not found/i);
  });

  it("delivers messages in order, counts unread for others only, and clears on read", async () => {
    const general = (await chat.listChannels(doc)).find((c) => c.name === "General")!;
    await chat.sendMessage(doc, general._id, "  Morning team  ", "Dr. Amina Khalid (synthetic)");
    await chat.sendMessage(doc, general._id, "Clinic 2 is free at ten", "Dr. Amina Khalid (synthetic)");
    const row = (c: typeof doc) => chat.listChannels(c).then((l) => l.find((x) => x._id === general._id)!);
    expect((await row(doc)).unread).toBe(0);
    expect((await row(rec)).unread).toBe(2);
    const msgs = await chat.getMessages(rec, general._id);
    expect(msgs.map((m) => m.body)).toEqual(["Morning team", "Clinic 2 is free at ten"]);
    expect(msgs[0].name).toBe("Dr. Amina Khalid");
    expect((await row(rec)).unread).toBe(0);
    expect(await chat.getMessages(rec, general._id, { after: msgs[0].at })).toHaveLength(1);
  });

  it("validates message text and rate limits a flood", async () => {
    const general = (await chat.listChannels(doc2)).find((c) => c.name === "General")!;
    await expect(chat.sendMessage(doc2, general._id, "   ", "x")).rejects.toThrow(/first/);
    await expect(chat.sendMessage(doc2, general._id, "a".repeat(chat.MAX_BODY + 1), "x")).rejects.toThrow(/characters/);
    for (let i = 0; i < 8; i++) await chat.sendMessage(doc2, general._id, `m${i}`, "x");
    await expect(chat.sendMessage(doc2, general._id, "one more", "x")).rejects.toThrow(/too fast/);
  });

  it("direct messages are private to the two people and the same from either side", async () => {
    const a = await chat.openDm(doc, ids.rec);
    const b = await chat.openDm(rec, ids.doc);
    expect(a._id).toBe(b._id);
    await chat.sendMessage(doc, a._id, "Please send the next patient", "Dr. Amina");
    expect((await chat.getMessages(rec, a._id)).length).toBe(1);
    await expect(chat.getMessages(acc, a._id)).rejects.toThrow(/not found/i);
    await expect(chat.getMessages(admin, a._id)).rejects.toThrow(/not found/i);
    expect((await chat.listChannels(rec)).some((c) => c._id === a._id)).toBe(true);
    expect((await chat.listChannels(acc)).some((c) => c._id === a._id)).toBe(false);
    await expect(chat.openDm(doc, ids.doc)).rejects.toThrow(/colleague/);
    await expect(chat.openDm(doc, ids.pt)).rejects.toThrow(/staff list/);
  });

  it("lists staff but not patients, with synthetic tags removed from names", async () => {
    const d = await chat.directory(doc);
    expect(d.some((p) => p.userId === ids.pt)).toBe(false);
    expect(d.find((p) => p.userId === ids.doc)?.name).toBe("Dr. Amina Khalid");
  });
});

describe("profile photos", () => {
  afterAll(closeClient);
  it("lets people change their own photo and HR change anyone's, nobody else", async () => {
    await savePhoto(doc, ids.doc, JPEG);
    await expect(savePhoto(rec, ids.doc, JPEG)).rejects.toThrow(/own photo/);
    await savePhoto(hr, ids.doc2, JPEG);
    const p = await getPhoto(rec, ids.doc);
    expect(p?.contentType).toBe("image/jpeg");
    expect(p?.data.length).toBe(JPEG.length);
    const v = await photoVersions(ORG, [ids.doc, ids.doc2, ids.acc]);
    expect([...v.keys()].sort()).toEqual([ids.doc, ids.doc2].sort());
  });
  it("rejects non-images, oversized files and people outside the staff list", async () => {
    await expect(savePhoto(doc, ids.doc, Buffer.from("<svg onload=alert(1)>"))).rejects.toThrow(/JPEG, PNG or WebP/);
    await expect(savePhoto(doc, ids.doc, Buffer.concat([JPEG, Buffer.alloc(400_001)]))).rejects.toThrow(/too large/);
    await expect(savePhoto(hr, newId(), JPEG)).rejects.toThrow(/staff list/);
  });
  it("keeps one organisation's photos away from another's", async () => {
    expect(await getPhoto(ctxFor(["doctor"], "other-org", newId(), "b"), ids.doc)).toBeNull();
  });
});

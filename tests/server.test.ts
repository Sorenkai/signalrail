import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server/app.ts";

const server = createApp(fileURLToPath(new URL("../data", import.meta.url)));
let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("dataset API", () => {
  it("reports health", async () => {
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
  });

  it("lists datasets and serves the real Shrewsbury dataset without validation errors", async () => {
    const { datasets } = await (await fetch(`${base}/api/datasets`)).json();
    expect(datasets).toContain("shrewsbury");
    const body = await (await fetch(`${base}/api/datasets/shrewsbury`)).json();
    expect(body.infrastructure.datasetId).toBe("shrewsbury");
    expect(body.issues.filter((i: { severity: string }) => i.severity === "error")).toEqual([]);
  });

  it("returns 404 for unknown datasets and rejects writes", async () => {
    expect((await fetch(`${base}/api/datasets/nowhere`)).status).toBe(404);
    expect((await fetch(`${base}/api/health`, { method: "POST" })).status).toBe(405);
  });
});

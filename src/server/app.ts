import { createServer, type Server } from "node:http";
import { listDatasets, loadDataset } from "../data/loadDataset.ts";
import { validateDataset } from "../validation/validate.ts";

/**
 * Phase 0 server: read-only dataset API. Multiplayer (Socket.IO, server-authoritative
 * simulation) is deferred until the data supports gameplay; see docs/DECISION_LOG.md.
 */
export function createApp(dataRoot: string): Server {
  return createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return send(405, { error: "method not allowed" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/health") return send(200, { ok: true });
    if (url.pathname === "/api/datasets") return send(200, { datasets: listDatasets(dataRoot) });
    const m = /^\/api\/datasets\/([a-z0-9-]+)$/.exec(url.pathname);
    if (m) {
      if (!listDatasets(dataRoot).includes(m[1]!)) return send(404, { error: "unknown dataset" });
      const { input, schemaIssues } = loadDataset(dataRoot, m[1]!);
      if (!input)
        return send(500, { error: "dataset failed schema validation", issues: schemaIssues });
      const issues = [...schemaIssues, ...validateDataset(input)];
      const { infrastructure, signalling, control, timingPoints, timetables, gameRules } = input;
      // Game rules stay a separate key: simplified game data, never merged into infrastructure.
      return send(200, {
        infrastructure,
        signalling,
        control,
        timingPoints,
        timetables,
        gameRules,
        issues,
      });
    }
    send(404, { error: "not found" });
  });
}

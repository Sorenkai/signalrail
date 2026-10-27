import { useMemo, useState } from "react";
import {
  Control,
  Infrastructure,
  Signalling,
  SourceRegistry,
  TimetableSnapshot,
  TimingPointsFile,
} from "../model/index.ts";
import { buildPreview } from "../schematic/preview.ts";
import { previewTimingPoints } from "../schematic/timingPoints.ts";
import { summariseEvidence, validateDataset } from "../validation/validate.ts";
import { attributionFor } from "../data/attribution.ts";
import { PreviewSvg } from "./PreviewSvg.tsx";
import sourcesJson from "../../data/sources.json";
import infraJson from "../../data/datasets/shrewsbury/infrastructure.json";
import controlJson from "../../data/datasets/shrewsbury/control.json";
import signallingJson from "../../data/datasets/shrewsbury/signalling.json";
import timingJson from "../../data/datasets/shrewsbury/timing-points.json";
import timetableJson from "../../data/datasets/shrewsbury/timetables/2026-11-04.json";

/**
 * Phase 0 data-inspection page: the Shrewsbury dataset as imported, its evidence levels and
 * validation issues. Not gameplay.
 */
export function App() {
  const [zoom, setZoom] = useState(1);
  const data = useMemo(() => {
    const sources = SourceRegistry.parse(sourcesJson);
    const infrastructure = Infrastructure.parse(infraJson);
    const timingPoints = TimingPointsFile.parse(timingJson);
    const timetable = TimetableSnapshot.parse(timetableJson);
    const input = {
      sources,
      infrastructure,
      control: Control.parse(controlJson),
      signalling: Signalling.parse(signallingJson),
      timingPoints: timingPoints.mappings,
      timingPointPositions: timingPoints.inferredPositions,
      areaTiplocs: timingPoints.areaTiplocs.map((t) => t.tiploc),
      timetables: [timetable],
    };
    return {
      infrastructure,
      timetable,
      attribution: attributionFor({ infrastructure, timetable }, sources),
      preview: buildPreview(infrastructure, {
        attribution: attributionFor({ infrastructure, timingPoints }, sources),
        timingPoints: previewTimingPoints(timingPoints, infrastructure),
      }),
      issues: validateDataset(input),
      evidence: summariseEvidence(input),
    };
  }, []);
  const i = data.infrastructure;

  return (
    <main>
      <header>
        <h1>Signal Network - Phase 0 data preview</h1>
        <p className="note">
          A game in development. Not affiliated with or endorsed by Network Rail or any railway
          operator.
        </p>
      </header>
      <section className="layout">
        <div className="canvas">
          <div className="toolbar">
            <button onClick={() => setZoom((z) => Math.max(1, z / 1.5))}>-</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(12, z * 1.5))}>+</button>
          </div>
          <div className="scroll">
            <PreviewSvg model={data.preview} zoom={zoom} />
          </div>
        </div>
        <aside>
          <h2>{i.datasetId}</h2>
          <p>
            {i.version} - {i.nodes.length} nodes, {i.edges.length} edges, {i.signals.length}{" "}
            signals, {i.points.length} points, {i.platforms.length} platforms
          </p>
          <p>
            Timetable {data.timetable.date}: {data.timetable.services.length} services (CIF{" "}
            {data.timetable.extract.fileRef}, extracted {data.timetable.extract.extractedAt})
          </p>
          <h3>Evidence</h3>
          <table>
            <tbody>
              {Object.entries(data.evidence.total).map(([level, n]) => (
                <tr key={level}>
                  <td>{level}</td>
                  <td>{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Validation ({data.issues.length})</h3>
          <ul className="issues">
            {data.issues.map((issue, k) => (
              <li key={k} className={issue.severity}>
                <b>{issue.code}</b> {issue.message}
              </li>
            ))}
          </ul>
          <h3>Legend</h3>
          <ul className="legend">
            <li>
              <span style={{ color: "#e8e8e8" }}>━</span> running line (OSM)
            </li>
            <li>
              <span style={{ color: "#7a8696" }}>━</span> siding / crossover / spur
            </li>
            <li>
              <span style={{ color: "#ff5a5a" }}>●</span> signal with direction tick, OSM ref
            </li>
            <li>
              <span style={{ color: "#4fb3ff" }}>●</span> points (lie unknown)
            </li>
            <li>
              <span style={{ color: "#ffb347" }}>□</span> area boundary (inferred)
            </li>
            <li>
              <span style={{ color: "#c58cff" }}>◆</span> timing point, sourced ·{" "}
              <span style={{ color: "#c58cff" }}>◇</span> TIPLOC? = inferred position
            </li>
          </ul>
        </aside>
      </section>
      <footer>{data.attribution}</footer>
    </main>
  );
}

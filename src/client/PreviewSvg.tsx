import type { PreviewModel } from "../schematic/preview.ts";

export function PreviewSvg({ model: m, zoom }: { model: PreviewModel; zoom: number }) {
  return (
    <svg
      viewBox={`0 0 ${m.width} ${m.height}`}
      width={m.width * zoom}
      height={m.height * zoom}
      role="img"
      aria-label={m.caption}
    >
      <rect width="100%" height="100%" fill="#10151c" />
      {m.studyArea && (
        <rect
          x={m.studyArea.x}
          y={m.studyArea.y}
          width={m.studyArea.w}
          height={m.studyArea.h}
          fill="none"
          stroke="#3a4656"
          strokeDasharray="6 4"
        />
      )}
      <g fill="none" strokeLinecap="round">
        {m.tracks.map((t) => (
          <polyline
            key={t.id}
            points={t.points}
            stroke={t.usage === "main" || t.usage === "branch" ? "#e8e8e8" : "#7a8696"}
            strokeWidth={(t.usage === "main" ? 2.5 : 1.5) / Math.sqrt(zoom)}
            strokeDasharray={
              t.evidence === "sourced" || t.evidence === "verified" ? undefined : "4 3"
            }
          >
            <title>{t.id}</title>
          </polyline>
        ))}
      </g>
      {m.points.map((p) => (
        <circle key={p.id} cx={p.x} cy={p.y} r={2.5 / Math.sqrt(zoom)} fill="#4fb3ff">
          <title>{p.id}</title>
        </circle>
      ))}
      {m.boundaries.map((p) => (
        <rect key={p.id} x={p.x - 4} y={p.y - 4} width={8} height={8} fill="none" stroke="#ffb347">
          <title>area boundary {p.id}</title>
        </rect>
      ))}
      {m.signals.map((s) => (
        <g key={s.id}>
          <line
            x1={s.x}
            y1={s.y}
            x2={s.x + s.dx / zoom}
            y2={s.y + s.dy / zoom}
            stroke="#ff5a5a"
            strokeWidth={2 / Math.sqrt(zoom)}
          />
          <circle
            cx={s.x}
            cy={s.y}
            r={3.5 / Math.sqrt(zoom)}
            fill={s.kind === "distant" ? "#ffd84f" : "#ff5a5a"}
          >
            <title>
              {s.id} {s.label ?? "(no ref)"} {s.kind}
            </title>
          </circle>
          {s.label && (
            <text
              x={s.x + 4 / zoom}
              y={s.y - 4 / zoom}
              fontSize={10 / Math.sqrt(zoom)}
              fill="#ffb0b0"
            >
              {s.label}
            </text>
          )}
        </g>
      ))}
      {m.timingPoints.map((t) => (
        <g key={t.tiploc}>
          <rect
            x={t.x - 4 / Math.sqrt(zoom)}
            y={t.y - 4 / Math.sqrt(zoom)}
            width={8 / Math.sqrt(zoom)}
            height={8 / Math.sqrt(zoom)}
            transform={`rotate(45 ${t.x} ${t.y})`}
            fill={t.inferred ? "none" : "#c58cff"}
            stroke="#c58cff"
            strokeWidth={1.5 / Math.sqrt(zoom)}
            strokeDasharray={t.inferred ? "2 1.5" : undefined}
          >
            <title>
              {t.tiploc} {t.inferred ? `(inferred, ${t.confidence} confidence)` : "(sourced)"}
            </title>
          </rect>
          <text
            x={t.x + 7 / Math.sqrt(zoom)}
            y={t.y + 3 / Math.sqrt(zoom)}
            fontSize={9 / Math.sqrt(zoom)}
            fill="#d9b8ff"
          >
            {t.tiploc}
            {t.inferred ? "?" : ""}
          </text>
        </g>
      ))}
      {m.labels.map((l) => (
        <text
          key={l.id}
          x={l.x}
          y={l.y}
          fontSize={(l.kind === "platform" ? 9 : 12) / Math.sqrt(zoom)}
          fill={l.kind === "signal_box" ? "#ffd84f" : "#9fe0a0"}
          textAnchor="middle"
        >
          {l.text}
        </text>
      ))}
    </svg>
  );
}

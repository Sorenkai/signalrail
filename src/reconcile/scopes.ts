import type { EvidenceScope } from "./signalEvidence.ts";

/**
 * Reconciliation scope per dataset. A scoping choice, not a geographic fact: CORPUS has no
 * coordinates, so area STANOX are selected by name. See docs/pilots/CARLISLE_PILOT.md.
 */
export const RECONCILIATION_SCOPES: Record<
  string,
  EvidenceScope & { corpusSignalPattern: RegExp }
> = {
  carlisle: {
    td: "CL",
    signalPrefix: "CE",
    /**
     * SMART TD CL locations that name Carlisle, Kingmoor or a Carlisle junction. Excluded CL
     * locations (Oxenholme, Penrith, Tebay, Shap, Gretna, Quintinshill, Dalston, Wigton, ...)
     * lie well outside the bbox.
     */
    stanox: {
      "09161": "CARLISLE",
      "09153": "CSLE KMRJ (Kingmoor; CORPUS CARLISLE CE 464/465/467 SIGNAL)",
      "09180": "PETTRLBJN (Petteril Bridge Jn)",
      "09199": "UPPBYBGJN (Upperby Bridge Jn)",
      "09159": "CALDEW JN",
      "09190": "CURROCKJN (Currock Jn)",
      "09141": "KNGMORUTS (Kingmoor Up Through Sdg)",
      "09157": "CSLE KMUL (Kingmoor Up Loop)",
      "09136": "CSLE KMUD (Kingmoor Up Departures)",
      "09138": "KNGMDASTB (Kingmoor Dn Arr Stop Board)",
      "09184": "KNGMS486 (Kingmoor signal CE486)",
      "09182": "KNGMS490 (Kingmoor signal CE490)",
      "09185": "KNGMS487 (Kingmoor signal CE487)",
      "09170": "CRLSLD1SB (no CORPUS entry)",
    },
    corpusSignalPattern: /CARLISLE|KINGMOOR/,
  },
};

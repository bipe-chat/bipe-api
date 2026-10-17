/** Staff-only research contract. Content is returned by the API, never bundled in bipe-web. */
export type ResearchStatus = "available" | "limited" | "announced" | "unsupported" | "unknown";
export type ResearchPriority = "P0" | "P1" | "P2" | "Later";
export type ResearchCell = { status: ResearchStatus; detail: string; sources: string[] };
export type ResearchSource = { id: string; title: string; url?: string; path?: string; kind: "primary" | "internal"; checked: string; note?: string };
export type ResearchFeature = {
  id: string; group: string; name: string; job: string;
  priority: ResearchPriority; stance: "Match" | "Differentiate" | "Validate" | "Defer";
  implication: string; acceptance: string; issues: number[];
  bipe: { detail: string; ledger: string[]; evidence: string[]; sources: string[] };
  platforms: Record<string, ResearchCell>;
};
export type BipeResearchSnapshot = {
  captured: string;
  issuesCaptured: string;
  inputs: { path: string; sha256: string; revision: string; dirty: boolean }[];
  capabilities: { id: string; name: string; note?: string; issue?: number; surfaces: Record<string, { status: string; evidence?: string[]; reason?: string }> }[];
  issues: { number: number; title: string; milestone: string | null; labels: string[] }[];
};
export type MessagingResearch = {
  version: number; reviewed: string; reviewAfter: string; title: string; summary: string;
  methodology: string[];
  groups: { id: string; title: string; question: string }[];
  platforms: { id: string; name: string; scope: string; role: string; strengths: string[]; limits: string[]; lesson: string; sources: string[] }[];
  strategy: { title: string; status: "Accepted direction" | "Proposal"; detail: string; sources: string[] }[];
  priorities: { id: string; title: string; detail: string; gate: string; features: string[]; sources: string[] }[];
  watchlist: { title: string; detail: string; sources: string[] }[];
  sources: ResearchSource[];
  features: ResearchFeature[];
  snapshot: BipeResearchSnapshot;
};

// Public MCP server (ADR 0130, ADR 0210 in bipe/docs/adr, bipe#438; bipe-shared docs/mcp.md). Stateless MCP over
// Streamable HTTP: one JSON-RPC 2.0 message per POST, answered as application/json, no session. Read-only, class
// public only: each tool answers with what the public /@handle page shows, nothing more.
import { mcpToolRules } from "./registry.js";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const MCP_MAX_BODY_BYTES = 16 * 1024;

/** What a tool may read: the public profile of an exact handle, or null (no handle, or the profile is off). */
export type PublicProfileLookup = (handle: string) => Promise<{
  handle: string;
  name: string;
  bio?: string;
  photo_url?: string;
  badge?: { payload: string };
} | null>;

type JsonRpcId = string | number | null;
type Reply = { status: 200 | 202 | 400; body?: unknown };

const HANDLE_INPUT = {
  type: "object",
  properties: { handle: { type: "string", description: "The @handle, with or without the @." } },
  required: ["handle"],
  additionalProperties: false,
};

/** The public tools of registries/mcp-tools.json, in the MCP tools/list shape. pt descriptions: Bipe is pt-BR first. */
export function publicTools() {
  return mcpToolRules.tools
    .filter((t) => t.surface === "public")
    .map((t) => ({
      name: t.name,
      title: t.en,
      description: `${t.pt} (${t.en})`,
      inputSchema: HANDLE_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: false },
    }));
}

const rpcError = (id: JsonRpcId, code: number, message: string): Reply => ({
  status: 200,
  body: { jsonrpc: "2.0", id, error: { code, message } },
});
const rpcResult = (id: JsonRpcId, result: unknown): Reply => ({ status: 200, body: { jsonrpc: "2.0", id, result } });
const toolResult = (data: Record<string, unknown>) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
});

/** The handle as the tools take it. Same rule as the profile route: lowercase, no leading @, else not found. */
function handleArg(args: unknown): string | null {
  const raw = (args as { handle?: unknown } | undefined)?.handle;
  if (typeof raw !== "string") return null;
  const handle = raw.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9._]{1,64}$/.test(handle) ? handle : null;
}

/** The seal fields of a lvl cnpj badge. The server signed the envelope; assistants are told to verify it themselves. */
function cnpjSeal(badge: { payload: string } | undefined) {
  if (!badge) return null;
  try {
    const p = JSON.parse(Buffer.from(badge.payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (p.lvl !== "cnpj") return null;
    return {
      name: p.name,
      legal_name: p.legal_name,
      cnpj: p.cnpj,
      checked_month: p.checked_month,
      ...(p.cvm ? { cvm: p.cvm } : {}),
    };
  } catch {
    return null;
  }
}

async function callTool(name: string, args: unknown, lookup: PublicProfileLookup, siteUrl: string) {
  if (!publicTools().some((t) => t.name === name)) return null;
  const handle = handleArg(args);
  if (!handle) return { ...toolResult({ found: false, reason: "handle_invalid" }), isError: true };
  const profile = await lookup(handle);
  const page = `${siteUrl.replace(/\/$/, "")}/@${handle}`;
  // ADR 0041: "no handle" and "profile off" look the same.
  if (!profile) return toolResult({ found: false, handle });
  const seal = cnpjSeal(profile.badge);
  switch (name) {
    case "resolve_handle":
      return toolResult({ found: true, handle: profile.handle, name: profile.name, page });
    case "get_public_profile":
      return toolResult({
        found: true,
        handle: profile.handle,
        name: profile.name,
        ...(profile.bio ? { bio: profile.bio } : {}),
        ...(profile.photo_url ? { photo_url: profile.photo_url } : {}),
        verified_company: seal !== null,
        page,
      });
    case "check_cnpj_seal":
      return toolResult({
        found: true,
        handle: profile.handle,
        verified_company: seal !== null,
        ...(seal ? { seal } : {}),
        page,
        note: "The seal is a signed badge. Apps check its signature with GET /v1/badges/{userId}; this answer alone is not proof.",
      });
  }
  return null;
}

/** One POST body, already read as text. Returns the HTTP status and the JSON body (none for 202). */
export async function handleMcp(text: string, lookup: PublicProfileLookup, siteUrl: string): Promise<Reply> {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } } };
  }
  // 2025-06-18 removed JSON-RPC batches.
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return rpcError(null, -32600, "Invalid Request");
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id: JsonRpcId = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
  if (m.jsonrpc !== "2.0") return rpcError(id, -32600, "Invalid Request");
  // A notification (no id) or a response from the client: accepted, no body.
  if (m.id === undefined || typeof m.method !== "string") return { status: 202 };
  const params = (m.params ?? {}) as Record<string, unknown>;
  switch (m.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "bipe-public", title: "Bipe", version: "1" },
        instructions:
          "Bipe's public data only: public profiles and company seals by @handle. No messages, no phone numbers, no Matrix IDs. Data stays on Bipe's server in Brazil.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: publicTools() });
    case "tools/call": {
      const result = await callTool(String(params.name ?? ""), params.arguments, lookup, siteUrl);
      if (!result) return rpcError(id, -32602, `Unknown tool: ${String(params.name ?? "")}`);
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, "Method not found");
  }
}

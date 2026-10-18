import assert from "node:assert/strict";
import http from "node:http";

export async function masStub(t) {
  const state = { mode: "ok", passwords: new Map(), passwordCalls: 0, deactivated: 0 };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const json = (body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (url.pathname === "/oauth2/token") return json({ access_token: "test-only-access-token", expires_in: 3600 });
      if (url.pathname === "/api/admin/v1/users" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error("oversized test request"); }
        return json({ data: { id: `mas-${JSON.parse(body).username}` } }, 201);
      }
      if (/^\/api\/admin\/v1\/users\/[^/]+\/deactivate$/.test(url.pathname) && req.method === "POST") {
        state.deactivated++;
        return json({ data: {} });
      }
      const lookup = /^\/api\/admin\/v1\/users\/by-username\/([^/]+)$/.exec(url.pathname);
      if (lookup && req.method === "GET") return json({ data: { id: decodeURIComponent(lookup[1]) } });
      const password = /^\/api\/admin\/v1\/users\/([^/]+)\/set-password$/.exec(url.pathname);
      if (password && req.method === "POST") {
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error("oversized test request"); }
        const input = JSON.parse(body);
        assert.ok(typeof input.password === "string", "test MAS expects a password");
        state.passwordCalls++;
        const mode = state.mode;
        state.mode = "ok";
        if (mode === "before-apply") return json({ errors: [] }, 500);
        if (mode === "reject") return json({ errors: [] }, 400);
        state.passwords.set(decodeURIComponent(password[1]), input.password);
        if (mode === "after-apply-drop") { req.socket.destroy(); return; }
        res.writeHead(204); res.end(); return;
      }
      json({ errors: [] }, 404);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return { ...state, get mode() { return state.mode; }, set mode(value) { state.mode = value; }, get passwordCalls() { return state.passwordCalls; }, get deactivated() { return state.deactivated; }, url: `http://127.0.0.1:${server.address().port}` };
}

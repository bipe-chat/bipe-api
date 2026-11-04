import http from "node:http";

// A fake Sygnal: records each notify request. status: the HTTP answer of the next requests (200 by default).
export async function pushGateway(t) {
  const state = { requests: [], status: 200 };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error("oversized test request"); }
    if (req.method === "POST" && req.url === "/_matrix/push/v1/notify") state.requests.push(JSON.parse(body));
    res.writeHead(state.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ rejected: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

/** A Bipe Next pusher as the Synapse admin API returns it. Synthetic values only. */
export function bipePusher(deviceId, route = `route-${deviceId}`) {
  return { app_id: "chat.bipe.app.ios", pushkey: `pushkey-${deviceId}`, kind: "http", enabled: true, device_id: deviceId, data: { url: "https://push.example.test/_matrix/push/v1/notify", format: "event_id_only", default_payload: { account_route: route } } };
}

/** The push kinds the gateway got, in order. */
export const kinds = (gateway) => gateway.state.requests.map((r) => r.notification.devices[0]?.data.default_payload.bipe_push_kind);

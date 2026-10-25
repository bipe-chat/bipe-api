import assert from "node:assert/strict";
import { test } from "node:test";
import { CVM_SOURCES, CVM_STOP_ORDERS, cvmField, refreshCvm } from "../dist/cvm.js";
import { isolatedDatabase } from "./helpers/database.mjs";
import { zip } from "./helpers/zip.mjs";

// CVM register check (ADR 0077, bipe#237) against Postgres, with a fake download. Synthetic CNPJs only.
const BROKER = "11222333000181";
const CANCELLED = "22333444000106";
const STOPPED = "33444555000102";
const BANK = "44555666000107";

function files({ stop = true, broken = false } = {}) {
  const csv = (rows) => ["CNPJ;DENOM_SOCIAL;SIT;TP_PARTIC;CATEG_REG;DT_REG;DT_CANCEL", ...rows].join("\r\n");
  const out = {};
  for (const s of CVM_SOURCES) {
    let text = csv([`${BROKER};A;EM FUNCIONAMENTO NORMAL;CORRETORA;Gestor de Recursos;2001-01-01;`]);
    if (s.id === "intermed") text = csv([`${BROKER};A;EM FUNCIONAMENTO NORMAL;CORRETORA;;2001-01-01;`, `${CANCELLED};B;CANCELADA;DISTRIBUIDORA;;1999-01-01;2010-05-06`, `${STOPPED};C;EM FUNCIONAMENTO NORMAL;CORRETORA;;2001-01-01;`]);
    if (broken && s.id === "crowdfunding") text = "CNPJ;NOME\r\n1;2";
    const entry = s.entry ? "cad_pj.csv" : "cad.csv";
    out[s.path] = s.path.endsWith(".zip") ? zip({ [entry]: text }) : Buffer.from(text, "latin1");
  }
  out[CVM_STOP_ORDERS] = Buffer.from([
    "Numero_Ato_Declaratorio;Data_Ato_Declaratorio;Denominacao;Data_Publicacao_DOU;CNPJ_CPF;Link_Download;Observacao",
    ...(stop ? [`21.000;2026-05-12;C;2026-05-13;33.444.555/0001-02;https://x;`] : []),
    `21.001;2026-05-12;Fulano;2026-05-13;123.456.789-09;https://x;`,
  ].join("\r\n"), "latin1");
  return (url) => {
    const path = url.replace("https://dados.cvm.gov.br/dados/", "");
    if (!out[path]) throw new Error(`no fake for ${path}`);
    return Promise.resolve(out[path]);
  };
}
const quiet = () => {};

test("the badge line per CNPJ follows ADR 0077 point 3", async (t) => {
  const db = await isolatedDatabase(t);
  assert.equal(await cvmField(db, BROKER, []), undefined, "never refreshed: no line");
  await refreshCvm(db, files(), quiet);
  const broker = await cvmField(db, BROKER, []);
  assert.equal(broker.st, "registered");
  assert.deepEqual(broker.cat.sort(), ["administradora de fundos imobiliários", "assessora de investimento", "consultora de valores mobiliários",
    "coordenadora de ofertas", "corretora", "gestor de recursos", "plataforma de investimento participativo"].sort());
  assert.deepEqual(await cvmField(db, CANCELLED, []), { st: "cancelled", on: "2010-05-06" });
  assert.deepEqual(await cvmField(db, STOPPED, []), { st: "stop_order", on: "2026-05-12" }, "a stop order overrides the registration");
  assert.deepEqual(await cvmField(db, BANK, ["6422100"]), { st: "no_registration" });
  assert.equal(await cvmField(db, BANK, ["4711302"]), undefined, "a shop gets no CVM line");
  assert.equal(await cvmField(db, BROKER, [], Date.now() + 8 * 86_400_000), undefined, "a table older than 7 days hides the line");
});

test("a failed refresh keeps the last good table and the stop-order flag", async (t) => {
  const db = await isolatedDatabase(t);
  await refreshCvm(db, files(), quiet);
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    await assert.rejects(refreshCvm(db, files({ stop: false, broken: true }), quiet), /unknown file shape/);
    await assert.rejects(refreshCvm(db, () => Promise.reject(new Error("GET x: HTTP 503")), quiet), /503/);
  } finally {
    console.error = orig;
  }
  assert.ok(errors.every((e) => e.includes("ALERT")));
  assert.deepEqual(await cvmField(db, STOPPED, []), { st: "stop_order", on: "2026-05-12" });
  const { rows } = await db.query("SELECT last_error FROM cvm_state");
  assert.match(rows[0].last_error, /503/);
  // A good file without the stop order clears it.
  await refreshCvm(db, files({ stop: false }), quiet);
  assert.equal((await cvmField(db, STOPPED, [])).st, "registered");
});

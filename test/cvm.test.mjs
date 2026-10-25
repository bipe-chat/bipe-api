import assert from "node:assert/strict";
import { test } from "node:test";
import { CVM_SOURCES, cvmDate, cvmStatus, isFinancialCnae, parseCsv, parseRegister, parseStopOrders, sourceText, unzip } from "../dist/cvm.js";
import { zip } from "./helpers/zip.mjs";

// CVM register check (ADR 0077, bipe#237): parsing of synthetic files in the shape ADR 0077 describes. No network.
const intermed = CVM_SOURCES.find((s) => s.id === "intermed");
const consultor = CVM_SOURCES.find((s) => s.id === "consultor");

test("CSV with ;, quotes, CRLF and a BOM", () => {
  const { header, rows } = parseCsv('﻿CNPJ;DENOM_SOCIAL;SIT\r\n"11.222.333/0001-81";"Corretora ""Boa"" S.A.";EM FUNCIONAMENTO NORMAL\r\n\r\n');
  assert.deepEqual(header, ["CNPJ", "DENOM_SOCIAL", "SIT"]);
  assert.deepEqual(rows, [["11.222.333/0001-81", 'Corretora "Boa" S.A.', "EM FUNCIONAMENTO NORMAL"]]);
});

test("dates, statuses and the financial CNAE divisions", () => {
  assert.equal(cvmDate("2025-03-14"), "2025-03-14");
  assert.equal(cvmDate("14/03/2025"), "2025-03-14");
  assert.equal(cvmDate(""), null);
  assert.equal(cvmStatus("EM FUNCIONAMENTO NORMAL"), "active");
  assert.equal(cvmStatus("CANCELADA"), "cancelled");
  assert.equal(cvmStatus("Cancelado"), "cancelled");
  assert.equal(cvmStatus("Em Análise"), "other");
  assert.equal(cvmStatus("Registro Não Concedido"), "other");
  assert.ok(isFinancialCnae(["6422100"]));
  assert.ok(isFinancialCnae([null, "6512000"]));
  assert.ok(isFinancialCnae(["6619-3/99"]));
  assert.equal(isFinancialCnae(["4711302", "8513900", null]), false);
});

test("a provider file gives one row per registration, with its category", () => {
  const text = [
    "CNPJ;DENOM_SOCIAL;SIT;TP_PARTIC;DT_REG;DT_CANCEL",
    "11.222.333/0001-81;CORRETORA A;EM FUNCIONAMENTO NORMAL;CORRETORA;2001-02-03;",
    "11.222.333/0001-81;CORRETORA A;CANCELADA;DISTRIBUIDORA;1999-01-01;2010-05-06",
    "sem cnpj;X;EM FUNCIONAMENTO NORMAL;CORRETORA;;",
  ].join("\r\n");
  assert.deepEqual(parseRegister(intermed, text), [
    { cnpj: "11222333000181", source: "intermed", category: "corretora", status: "active", registeredOn: "2001-02-03", cancelledOn: null },
    { cnpj: "11222333000181", source: "intermed", category: "distribuidora", status: "cancelled", registeredOn: "1999-01-01", cancelledOn: "2010-05-06" },
  ]);
  // No category column: the source's own label.
  const plain = parseRegister(consultor, "CNPJ;DENOM_SOCIAL;SIT\r\n11222333000181;C;EM FUNCIONAMENTO NORMAL");
  assert.equal(plain[0].category, "consultora de valores mobiliários");
});

test("an unknown shape or an empty file fails, so the last good table stays", () => {
  assert.throws(() => parseRegister(intermed, "CNPJ;NOME;SIT;TP_PARTIC\r\n11222333000181;A;X;Y"), /unknown file shape/);
  assert.throws(() => parseRegister(intermed, "CNPJ;DENOM_SOCIAL;SIT\r\n11222333000181;A;X"), /unknown file shape/);
  assert.throws(() => parseRegister(consultor, "CNPJ;DENOM_SOCIAL;SIT\r\n"), /no rows/);
  assert.throws(() => parseStopOrders("Numero;Data\r\n1;2"), /unknown file shape/);
});

test("stop orders count only rows with a CNPJ", () => {
  const text = [
    "Numero_Ato_Declaratorio;Data_Ato_Declaratorio;Denominacao;Data_Publicacao_DOU;CNPJ_CPF;Link_Download;Observacao",
    "21.000;2026-05-12;Golpe Invest Ltda;2026-05-13;11.222.333/0001-81;https://x;",
    "21.001;2026-05-12;Fulano;2026-05-13;123.456.789-09;https://x;",
    "21.002;2026-05-12;Sem documento;2026-05-13;;https://x;",
  ].join("\r\n");
  assert.deepEqual(parseStopOrders(text), [{ cnpj: "11222333000181", act: "21.000", on: "2026-05-12" }]);
});

test("a zip with several CSVs: the source takes its _pj file", () => {
  const adm = CVM_SOURCES.find((s) => s.id === "adm_cart");
  const body = zip({ "cad_adm_cart_pf.csv": "CPF;NOME\r\n1;2", "cad_adm_cart_pj.csv": "CNPJ;DENOM_SOCIAL;SIT;CATEG_REG\r\n11222333000181;G;EM FUNCIONAMENTO NORMAL;Gestor de Recursos", "LEIAME.txt": "x" });
  assert.deepEqual([...unzip(body).keys()], ["cad_adm_cart_pf.csv", "cad_adm_cart_pj.csv", "LEIAME.txt"]);
  assert.equal(parseRegister(adm, sourceText(adm, body))[0].category, "gestor de recursos");
  assert.throws(() => sourceText(intermed, zip({ "a.csv": "x", "b.csv": "y" })), /expected one CSV/);
});

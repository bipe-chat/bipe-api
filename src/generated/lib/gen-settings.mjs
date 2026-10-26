// Settings structure (registries/settings.json, ADR 0112): validation and Swift/Kotlin output.

const KINDS = ["link", "choice", "switch", "info", "url", "action", "destructive"];
const GATE = /^(ios|android|flag:[A-Za-z]+|planned:\d+)$/;
const KEY = /^[a-z][A-Za-z]*$/;

function fail(msg) {
  throw new Error(`registry validation failed: settings: ${msg}`);
}

export function validateSettings(reg) {
  const s = reg.settings;
  const has = (key) => key in reg.strings.strings && key in reg.stringsEn.strings;
  const needString = (key, where) => {
    if (!/^bipe_/.test(key) || !has(key)) fail(`${where}: string "${key}" missing in pt-BR or en`);
  };
  const groups = new Set();
  for (const [name, url] of Object.entries(s.urls)) {
    if (!/^https:\/\/bipe\.chat\//.test(url.pt) || !/^https:\/\/bipe\.chat\/en\//.test(url.en)) fail(`url ${name} must be bipe.chat, en under /en/`);
  }
  for (const g of s.groups) {
    if (!KEY.test(g.key) || groups.has(g.key)) fail(`group key "${g.key}"`);
    groups.add(g.key);
    needString(g.title, g.key);
    if (g.screen !== undefined && g.screen !== "element") fail(`${g.key}: screen must be "element"`);
    if (g.screen === "element" && g.sections.length) fail(`${g.key}: an element screen lists no rows`);
    const sections = new Set();
    for (const sec of g.sections) {
      if (!KEY.test(sec.key) || sections.has(sec.key)) fail(`${g.key}: section key "${sec.key}"`);
      sections.add(sec.key);
      if (sec.title) needString(sec.title, `${g.key}.${sec.key}`);
      if (sec.footer) needString(sec.footer, `${g.key}.${sec.key}`);
      if (!sec.rows.length) fail(`${g.key}.${sec.key}: no rows`);
      for (const r of sec.rows) {
        const where = `${g.key}.${sec.key}.${r.key}`;
        if (!KEY.test(r.key)) fail(`${where}: key`);
        if (!KINDS.includes(r.kind)) fail(`${where}: kind "${r.kind}"`);
        needString(r.title, where);
        if (r.footer) needString(r.footer, where);
        if (r.gate !== undefined && !GATE.test(r.gate)) fail(`${where}: gate "${r.gate}"`);
        if ((r.kind === "url") !== (r.url !== undefined)) fail(`${where}: a url row and only a url row names a url`);
        if (r.url !== undefined && !(r.url in s.urls)) fail(`${where}: unknown url "${r.url}"`);
        if (r.adr !== undefined && !/^\d{4}$/.test(r.adr)) fail(`${where}: adr`);
      }
    }
  }
  const rowIds = s.groups.flatMap((g) => g.sections.flatMap((sec) => sec.rows.map((r) => `${g.key}.${r.key}`)));
  if (new Set(rowIds).size !== rowIds.length) fail("row keys must be unique inside a group");
  if (!groups.has("profile")) fail("profile group missing");
  for (const k of s.root) if (!groups.has(k) || k === "profile") fail(`root "${k}"`);
  if (new Set(s.root).size !== s.root.length) fail("root has a duplicate");
  for (const g of groups) if (g !== "profile" && !s.root.includes(g)) fail(`group "${g}" is not in root`);
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const rowsOf = (s) => s.groups.flatMap((g) => g.sections.flatMap((sec) => sec.rows.map((r) => ({ g, sec, r, id: `${g.key}${cap(r.key)}` }))));
const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

export function generateSettings(s, lang, header, quote) {
  const rows = rowsOf(s);
  if (lang === "swift") {
    const loc = (key) => `NSLocalizedString(${quote(key)}, tableName: "Bipe", bundle: .module, comment: "")`;
    const opt = (key) => (key ? quote(key) : "nil");
    const sectionLit = (g, sec) =>
      `BipeSettingsSection(key: ${quote(sec.key)}, titleKey: ${opt(sec.title)}, footerKey: ${opt(sec.footer)}, rows: [${sec.rows.map((r) => `.${g.key}${cap(r.key)}`).join(", ")}])`;
    return `${header}
import Foundation

/// Settings structure (ADR 0112). Source: bipe-shared/registries/settings.json.
public enum BipeSettingsGroup: String, CaseIterable, Sendable {
${s.groups.map((g) => `    case ${g.key}`).join("\n")}

    /// The group rows under "Configurações" in the Você tab, in order. \`profile\` opens from the header.
    public static let root: [BipeSettingsGroup] = [${s.root.map((k) => `.${k}`).join(", ")}]

    public var title: String {
        switch self {
${s.groups.map((g) => `        case .${g.key}: ${loc(g.title)}`).join("\n")}
        }
    }

    /// True when the group keeps its Element screen and lists no rows here.
    public var usesElementScreen: Bool {
        switch self {
${s.groups.map((g) => `        case .${g.key}: ${g.screen === "element"}`).join("\n")}
        }
    }

    public var sections: [BipeSettingsSection] {
        switch self {
${s.groups.map((g) => `        case .${g.key}: [${g.sections.map((sec) => sectionLit(g, sec)).join(", ")}]`).join("\n")}
        }
    }
}

public struct BipeSettingsSection: Sendable, Equatable {
    public let key: String
    public let titleKey: String?
    public let footerKey: String?
    public let rows: [BipeSettingsRow]

    public var title: String? { titleKey.map { NSLocalizedString($0, tableName: "Bipe", bundle: .module, comment: "") } }
    public var footer: String? { footerKey.map { NSLocalizedString($0, tableName: "Bipe", bundle: .module, comment: "") } }
}

public enum BipeSettingsRowKind: String, Sendable {
${KINDS.map((k) => `    case \`${k}\``).join("\n")}
}

public enum BipeSettingsRow: String, CaseIterable, Sendable {
${rows.map(({ g, r, id }) => `    case ${id} = ${quote(`${g.key}.${r.key}`)}`).join("\n")}

    public var kind: BipeSettingsRowKind {
        switch self {
${rows.map(({ r, id }) => `        case .${id}: .${r.kind}`).join("\n")}
        }
    }

    /// Localised title. Rows with a %1$s placeholder (\`accountBiometricUnlock\`) format it themselves from \`titleKey\`.
    public var title: String { NSLocalizedString(titleKey, tableName: "Bipe", bundle: .module, comment: "") }

    public var titleKey: String {
        switch self {
${rows.map(({ r, id }) => `        case .${id}: ${quote(r.title)}`).join("\n")}
        }
    }

    public var footer: String? {
        switch self {
${rows.map(({ r, id }) => `        case .${id}: ${r.footer ? loc(r.footer) : "nil"}`).join("\n")}
        }
    }

    /// nil: always shown. "ios" / "android": that platform only. "flag:<name>": behind that feature flag.
    /// "planned:<issue>": hidden until bipe-chat/bipe#<issue> ships.
    public var gate: String? {
        switch self {
${rows.map(({ r, id }) => `        case .${id}: ${opt(r.gate)}`).join("\n")}
        }
    }

    /// The page a url row opens, in the app language ("pt" or "en").
    public func url(language: String) -> URL? {
        switch self {
${rows.filter(({ r }) => r.url).map(({ r, id }) => `        case .${id}: URL(string: language == "pt" ? ${quote(s.urls[r.url].pt)} : ${quote(s.urls[r.url].en)})`).join("\n")}
        default: nil
        }
    }
}
`;
  }
  // Kotlin
  const res = (key) => `R.string.${key}`;
  const optRes = (key) => (key ? res(key) : "null");
  return `${header}
package chat.bipe.shared.generated

import androidx.annotation.StringRes
import chat.bipe.shared.R

/** Settings structure (ADR 0112). Source: bipe-shared/registries/settings.json. */
enum class BipeSettingsRowKind { ${KINDS.map((k) => k.toUpperCase()).join(", ")} }

/**
 * gate: null = always shown; "ios" / "android" = that platform only; "flag:<name>" = behind that feature flag;
 * "planned:<issue>" = hidden until bipe-chat/bipe#<issue> ships.
 */
enum class BipeSettingsRow(
    val id: String,
    val kind: BipeSettingsRowKind,
    @StringRes val title: Int,
    @StringRes val footer: Int?,
    val gate: String?,
    val urlPt: String?,
    val urlEn: String?,
) {
${rows.map(({ g, r, id }) => `    ${snake(id)}(${quote(`${g.key}.${r.key}`)}, BipeSettingsRowKind.${r.kind.toUpperCase()}, ${res(r.title)}, ${optRes(r.footer)}, ${r.gate ? quote(r.gate) : "null"}, ${r.url ? quote(s.urls[r.url].pt) : "null"}, ${r.url ? quote(s.urls[r.url].en) : "null"}),`).join("\n")}
    ;

    /** The page a url row opens, in the app language ("pt" or "en"). */
    fun url(language: String): String? = if (language == "pt") urlPt else urlEn
}

data class BipeSettingsSection(
    val key: String,
    @StringRes val title: Int?,
    @StringRes val footer: Int?,
    val rows: List<BipeSettingsRow>,
)

enum class BipeSettingsGroup(
    @StringRes val title: Int,
    /** True when the group keeps its Element screen and lists no rows here. */
    val usesElementScreen: Boolean,
) {
${s.groups.map((g) => `    ${snake(g.key)}(${res(g.title)}, ${g.screen === "element"}),`).join("\n")}
    ;

    val sections: List<BipeSettingsSection>
        get() = when (this) {
${s.groups.map((g) => `            ${snake(g.key)} -> listOf(${g.sections.map((sec) => `BipeSettingsSection(${quote(sec.key)}, ${optRes(sec.title)}, ${optRes(sec.footer)}, listOf(${sec.rows.map((r) => `BipeSettingsRow.${snake(`${g.key}${cap(r.key)}`)}`).join(", ")}))`).join(", ")})`).join("\n")}
        }

    companion object {
        /** The group rows under "Configurações" in the Você tab, in order. [PROFILE] opens from the header. */
        val root: List<BipeSettingsGroup> = listOf(${s.root.map((k) => snake(k)).join(", ")})
    }
}
`;
}

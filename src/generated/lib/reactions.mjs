// SPDX-License-Identifier: AGPL-3.0-only
// Additional permission: APP-STORE-PERMISSION.md (AGPL section 7)
// Copyright 2026 Bipe contributors

// Shared reaction presentation and its generated native counterparts. No transport or message permissions here.
export function validateMessageReactions(rule) {
  if (rule?.version !== 1 || !Array.isArray(rule.quickKeys) || rule.quickKeys.length < 1 || rule.quickKeys.length > 12
      || new Set(rule.quickKeys).size !== rule.quickKeys.length
      || rule.quickKeys.some(key => typeof key !== "string" || !key || /[\p{Cc}\p{Z}]/u.test(key))
      || !Number.isSafeInteger(rule.displayKeyMaxGraphemes) || rule.displayKeyMaxGraphemes < 1 || rule.displayKeyMaxGraphemes > 64) {
    throw new Error("message-reactions: unique nonempty quick keys and a display limit from 1 to 64 required");
  }
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  if (rule.quickKeys.some(key => [...segmenter.segment(key)].length !== 1)) throw new Error("message-reactions: each quick key must be one grapheme");
}

export function reactionKeyText(key, rule) {
  const chars = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(key)].map(part => part.segment);
  return chars.length > rule.displayKeyMaxGraphemes ? chars.slice(0, rule.displayKeyMaxGraphemes).join("") + "…" : key;
}

export function generateReactions(rule, language, header, quote) {
  validateMessageReactions(rule);
  if (language === "swift") return header + `
public nonisolated enum BipeReactions {
    public static let quickKeys: [String] = [${rule.quickKeys.map(quote).join(", ")}]
    public static let displayKeyMaxGraphemes = ${rule.displayKeyMaxGraphemes}
    public static func keyText(_ key: String) -> String {
        key.count > displayKeyMaxGraphemes ? String(key.prefix(displayKeyMaxGraphemes)) + "…" : key
    }
}
`;
  if (language !== "kotlin") throw new Error("unsupported reactions language");
  return header + `
package chat.bipe.shared.generated

object BipeReactions {
    val quickKeys: List<String> = listOf(${rule.quickKeys.map(quote).join(", ")})
    const val displayKeyMaxGraphemes = ${rule.displayKeyMaxGraphemes}
    private val grapheme = Regex("\\\\X")
    fun keyText(key: String): String {
        val characters = grapheme.findAll(key).map { it.value }.toList()
        return if (characters.size > displayKeyMaxGraphemes) characters.take(displayKeyMaxGraphemes).joinToString("") + "…" else key
    }
}
`;
}

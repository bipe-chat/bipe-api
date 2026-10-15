export function validateAgendaTemplates(reg) {
  const fail = (message) => { throw new Error(`agenda templates: ${message}`); };
  const templates = reg.agendaTemplates.templates;
  if (!Array.isArray(templates) || templates.length === 0) fail("empty registry");
  const stringKey = (key) => {
    if (!reg.strings.strings[key] || !reg.stringsEn.strings[key]) fail(`missing translation ${key}`);
  };
  const ids = new Set();
  for (const template of templates) {
    if (!/^[a-z][a-z-]*$/.test(template.id) || ids.has(template.id)) fail(`invalid or duplicate ID ${template.id}`);
    ids.add(template.id);
    stringKey(template.title_key);
    if (!Array.isArray(template.services) || !template.services.length) fail(`${template.id}: no services`);
    const services = new Set();
    for (const service of template.services) {
      if (!/^[a-z][a-z-]*$/.test(service.id) || services.has(service.id)) fail(`${template.id}: invalid or duplicate service`);
      services.add(service.id);
      stringKey(service.name_key);
      for (const [key, minimum] of [["duration_minutes", 1], ["buffer_before_minutes", 0], ["buffer_after_minutes", 0]]) {
        if (!Number.isInteger(service[key]) || service[key] < minimum) fail(`${template.id}: invalid ${key}`);
      }
      if (service.price?.mode !== "on_request" || Object.keys(service.price).length !== 1) fail(`${template.id}: price must start on request`);
    }
    if (!Array.isArray(template.availability) || !template.availability.length) fail(`${template.id}: no hours`);
    const ranges = new Map();
    for (const rule of template.availability) {
      if (!Number.isInteger(rule.weekday) || rule.weekday < 1 || rule.weekday > 7) fail(`${template.id}: weekday`);
      for (const key of ["start", "end"]) if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(rule[key])) fail(`${template.id}: ${key}`);
      if (rule.end <= rule.start) fail(`${template.id}: reversed range`);
      const day = ranges.get(rule.weekday) ?? [];
      if (day.some((other) => other.start < rule.end && rule.start < other.end)) fail(`${template.id}: overlapping ranges`);
      day.push(rule);
      ranges.set(rule.weekday, day);
    }
  }
}

export function generateAgendaTemplates(reg, platform, header) {
  const quoted = JSON.stringify;
  const templates = reg.agendaTemplates.templates;
  if (platform === "swift") return `${header}
public struct BipeAgendaTemplateService: Sendable {
    public let id: String
    public let nameKey: String
    public let durationMinutes: Int
    public let bufferBeforeMinutes: Int
    public let bufferAfterMinutes: Int
}

public struct BipeAgendaTemplateHours: Sendable {
    public let weekday: Int
    public let start: String
    public let end: String
}

public struct BipeAgendaTemplate: Sendable {
    public let id: String
    public let titleKey: String
    public let services: [BipeAgendaTemplateService]
    public let availability: [BipeAgendaTemplateHours]
}

public enum BipeAgendaTemplates {
    /// Editable setup suggestions. Every service starts with its price on request.
    public static let templates: [BipeAgendaTemplate] = [
${templates.map((t) => `        .init(id: ${quoted(t.id)}, titleKey: ${quoted(t.title_key)}, services: [
${t.services.map((s) => `            .init(id: ${quoted(s.id)}, nameKey: ${quoted(s.name_key)}, durationMinutes: ${s.duration_minutes}, bufferBeforeMinutes: ${s.buffer_before_minutes}, bufferAfterMinutes: ${s.buffer_after_minutes}),`).join("\n")}
        ], availability: [
${t.availability.map((r) => `            .init(weekday: ${r.weekday}, start: ${quoted(r.start)}, end: ${quoted(r.end)}),`).join("\n")}
        ]),`).join("\n")}
    ]
}
`;
  if (platform === "kotlin") return `${header}
package io.element.android.libraries.bipe.generated

data class BipeAgendaTemplateService(val id: String, val nameKey: String, val durationMinutes: Int, val bufferBeforeMinutes: Int, val bufferAfterMinutes: Int)
data class BipeAgendaTemplateHours(val weekday: Int, val start: String, val end: String)
data class BipeAgendaTemplate(val id: String, val titleKey: String, val services: List<BipeAgendaTemplateService>, val availability: List<BipeAgendaTemplateHours>)

object BipeAgendaTemplates {
    // Editable setup suggestions. Every service starts with its price on request.
    val templates: List<BipeAgendaTemplate> = listOf(
${templates.map((t) => `        BipeAgendaTemplate(id = ${quoted(t.id)}, titleKey = ${quoted(t.title_key)}, services = listOf(
${t.services.map((s) => `            BipeAgendaTemplateService(${quoted(s.id)}, ${quoted(s.name_key)}, ${s.duration_minutes}, ${s.buffer_before_minutes}, ${s.buffer_after_minutes}),`).join("\n")}
        ), availability = listOf(
${t.availability.map((r) => `            BipeAgendaTemplateHours(${r.weekday}, ${quoted(r.start)}, ${quoted(r.end)}),`).join("\n")}
        )),`).join("\n")}
    )
}
`;
  throw new Error(`unsupported agenda template platform: ${platform}`);
}

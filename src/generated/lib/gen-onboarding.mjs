// First run (registries/onboarding.json, bipe-chat/bipe#415): validation and Swift/Kotlin output.

const TARGETS = ["inviteCode", "name", "pin", "fallback", "create", "recovery", "waitlist", "systemPermission", "handleScreen", "recoveryEmailAdd", "dismiss", "shareInvite", "shareProfile", "profileQr", "notes", "photoPicker", "pinCheck", "bringPeopleSheet", "bringPeopleResend", "osTheftSettings"];
const STATES = ["syncedToken"];
const CARD_STATES = ["hasHandle"];
const TRIGGERS = ["firstMessageSent", "chatListWithoutHandle", "chatListWithoutRecovery", "voceWithoutPhoto", "pinReminderDue", "firstChatListAfterSignup", "bringPeopleDue", "voceAfterDays"];
const CIRCLES = ["family", "building"];
const TIERS = ["critical", "access", "safety", "identity", "growth", "discovery"];
const PREEMPTS = ["critical", "access"];
const KEY = /^[a-z][A-Za-z]*$/;

function fail(msg) {
  throw new Error(`registry validation failed: onboarding: ${msg}`);
}

export function validateOnboarding(reg) {
  const o = reg.onboarding;
  const has = (key) => key in reg.strings.strings && key in reg.stringsEn.strings;
  const needString = (key, where) => {
    if (typeof key !== "string" || !/^bipe_/.test(key) || !has(key)) fail(`${where}: string "${key}" missing in pt-BR or en`);
  };
  const keys = new Set();
  const needKey = (key, where) => {
    if (!KEY.test(key) || keys.has(key)) fail(`${where}: key "${key}"`);
    keys.add(key);
  };
  const needButtons = (screen, where) => {
    if (!screen.primary) fail(`${where}: one primary button required`);
    for (const b of [screen.primary, ...screen.text]) {
      needString(b.title, where);
      if (!TARGETS.includes(b.to)) fail(`${where}: unknown target "${b.to}"`);
    }
  };

  for (const s of o.start) {
    needKey(s.key, "start");
    needString(s.title, s.key);
    needButtons(s, s.key);
    for (const c of ["invitePending", "inviteRequired"]) if (![true, false, null].includes(s[c])) fail(`${s.key}: ${c} must be true, false or null`);
  }
  for (const invitePending of [true, false]) {
    for (const inviteRequired of [true, false]) {
      const n = o.start.filter((s) => matches(s, invitePending, inviteRequired)).length;
      if (n !== 1) fail(`start: ${n} variants match invitePending=${invitePending}, inviteRequired=${inviteRequired}`);
    }
  }
  for (const s of o.steps) {
    needKey(s.key, "steps");
    if (!TARGETS.includes(s.key)) fail(`step "${s.key}" is not a target`);
    needString(s.title, s.key);
    if (s.body !== undefined) needString(s.body, s.key);
    needButtons(s, s.key);
  }
  needString(o.waitlist.body, "waitlist");
  needString(o.waitlist.done, "waitlist");
  needButtons({ ...o.waitlist, text: [] }, "waitlist");
  needString(o.created, "created");
  for (const r of o.recovery) {
    needKey(r.key, "recovery");
    needString(r.title, r.key);
    needString(r.body, r.key);
    if (r.when !== undefined && !STATES.includes(r.when)) fail(`${r.key}: when "${r.when}"`);
    if (r.gate !== undefined && !/^(planned:\d+|flag:developer)$/.test(r.gate)) fail(`${r.key}: gate "${r.gate}"`);
  }
  if (!Number.isInteger(o.promptSlot?.hours) || o.promptSlot.hours < 1) fail("promptSlot.hours must be a whole number of hours");
  const pr = o.pinReminder;
  if (!Array.isArray(pr?.days) || pr.days.length === 0 || !pr.days.every((d) => Number.isInteger(d) && d > 0)) fail("pinReminder.days must be whole days");
  if (!Number.isInteger(pr.thenEveryDays) || pr.thenEveryDays < 1) fail("pinReminder.thenEveryDays must be whole days");
  if (!Number.isInteger(o.osTheftProtection?.afterDays) || o.osTheftProtection.afterDays < 0) fail("osTheftProtection.afterDays must be whole days");
  const bp = o.bringPeople;
  for (const k of ["slots", "followUpEveryDays", "pendingAfterDays", "stopAfterDeclines"]) {
    if (!Number.isInteger(bp?.[k]) || bp[k] < 1) fail(`bringPeople.${k} must be a whole number above 0`);
  }
  if (!CIRCLES.includes(bp.firstCircle)) fail(`bringPeople.firstCircle "${bp.firstCircle}"`);
  const first = o.firstList;
  if (!first || !Number.isInteger(first.maxChats) || first.maxChats < 0) fail("firstList.maxChats must be a whole number");
  for (const c of first.cards) {
    if (!KEY.test(c.key) || first.cards.filter((d) => d.key === c.key).length > 1) fail(`firstList: key "${c.key}"`);
    needString(c.title, c.key);
    needString(c.body, c.key);
    needButtons(c, c.key);
    if (c.when !== undefined && !CARD_STATES.includes(c.when)) fail(`${c.key}: when "${c.when}"`);
  }
  const clp = o.chatListPrompt?.entries;
  if (!Array.isArray(clp) || clp.length === 0) fail("chatListPrompt.entries required");
  clp.forEach((e, i) => {
    if (!KEY.test(e.key) || clp.filter((d) => d.key === e.key).length > 1) fail(`chatListPrompt: key "${e.key}"`);
    if (!TIERS.includes(e.tier)) fail(`chatListPrompt ${e.key}: tier "${e.tier}"`);
    if (i > 0 && TIERS.indexOf(e.tier) < TIERS.indexOf(clp[i - 1].tier)) fail(`chatListPrompt ${e.key}: entries must be in tier order`);
  });
  for (const p of o.prompts) {
    needKey(p.key, "prompts");
    if (!TRIGGERS.includes(p.trigger)) fail(`${p.key}: trigger "${p.trigger}"`);
    if (p.slot !== undefined && typeof p.slot !== "boolean") fail(`${p.key}: slot must be true or false`);
    needString(p.title, p.key);
    needString(p.body, p.key);
    needButtons(p, p.key);
  }
}

const matches = (s, invitePending, inviteRequired) =>
  s.invitePending === invitePending && (s.inviteRequired === null || s.inviteRequired === inviteRequired);

const snake = (s) => s.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

/** The start variant for each (invitePending, inviteRequired) pair, in a fixed order. */
const startTable = (o) =>
  [true, false].flatMap((p) => [true, false].map((r) => ({ p, r, key: o.start.find((s) => matches(s, p, r)).key })));

export function generateOnboarding(o, lang, header, quote) {
  if (lang === "swift") {
    const opt = (key) => (key ? quote(key) : "nil");
    const button = (b) => `BipeOnboardingButton(titleKey: ${quote(b.title)}, target: .${b.to})`;
    const screenMembers = (list) => `    public var titleKey: String {
        switch self {
${list.map((s) => `        case .${s.key}: ${quote(s.title)}`).join("\n")}
        }
    }

    public var bodyKey: String? {
        switch self {
${list.map((s) => `        case .${s.key}: ${opt(s.body)}`).join("\n")}
        }
    }

    /// The one filled button.
    public var primary: BipeOnboardingButton {
        switch self {
${list.map((s) => `        case .${s.key}: ${button(s.primary)}`).join("\n")}
        }
    }

    /// Text buttons, in order under the filled button.
    public var text: [BipeOnboardingButton] {
        switch self {
${list.map((s) => `        case .${s.key}: [${s.text.map(button).join(", ")}]`).join("\n")}
        }
    }`;
    return `${header}
import Foundation

// First run (bipe-chat/bipe#415). Source: bipe-shared/registries/onboarding.json.

public enum BipeOnboardingTarget: String, Sendable {
${TARGETS.map((t) => `    case ${t}`).join("\n")}
}

public struct BipeOnboardingButton: Sendable, Equatable {
    public let titleKey: String
    public let target: BipeOnboardingTarget

    public init(titleKey: String, target: BipeOnboardingTarget) {
        self.titleKey = titleKey
        self.target = target
    }

    public var title: String { NSLocalizedString(titleKey, tableName: "Bipe", bundle: .module, comment: "") }
}

/// The start screen. Exactly one variant matches each state.
public enum BipeOnboardingStart: String, CaseIterable, Sendable {
${o.start.map((s) => `    case ${s.key}`).join("\n")}

    public static func variant(invitePending: Bool, inviteRequired: Bool) -> BipeOnboardingStart {
        switch (invitePending, inviteRequired) {
${startTable(o).map(({ p, r, key }) => `        case (${p}, ${r}): .${key}`).join("\n")}
        }
    }

${screenMembers(o.start)}
}

/// Sign-up screens, in order.
public enum BipeOnboardingStep: String, CaseIterable, Sendable {
${o.steps.map((s) => `    case ${s.key}`).join("\n")}

${screenMembers(o.steps)}
}

/// Prompts after the account exists.
public enum BipeOnboardingPrompt: String, CaseIterable, Sendable {
${o.prompts.map((p) => `    case ${p.key}`).join("\n")}

${screenMembers(o.prompts)}

    /// True when the prompt shares the one prompt slot (\`BipeOnboarding.promptSlotHours\`, bipe-chat/bipe#200).
    public var usesSlot: Bool {
        switch self {
${o.prompts.map((p) => `        case .${p.key}: ${p.slot === true}`).join("\n")}
        }
    }
}

/// Rows of "Já tenho conta", in screen order.
public enum BipeOnboardingRecoveryRow: String, CaseIterable, Sendable {
${o.recovery.map((r) => `    case ${r.key}`).join("\n")}

    public var titleKey: String {
        switch self {
${o.recovery.map((r) => `        case .${r.key}: ${quote(r.title)}`).join("\n")}
        }
    }

    public var bodyKey: String {
        switch self {
${o.recovery.map((r) => `        case .${r.key}: ${quote(r.body)}`).join("\n")}
        }
    }

    /// True when the row shows only while the phone holds a synced recovery token.
    public var needsSyncedToken: Bool {
        switch self {
${o.recovery.map((r) => `        case .${r.key}: ${r.when === "syncedToken"}`).join("\n")}
        }
    }

    /// "planned:<issue>" when the row stays hidden until that issue ships; "flag:developer" for developer builds only.
    public var gate: String? {
        switch self {
${o.recovery.map((r) => `        case .${r.key}: ${opt(r.gate)}`).join("\n")}
        }
    }
}

/// Cards at the top of Conversas while it lists at most \`BipeOnboarding.firstListMaxChats\` chats (bipe-chat/bipe#198).
public enum BipeOnboardingCard: String, CaseIterable, Sendable {
${o.firstList.cards.map((c) => `    case ${c.key}`).join("\n")}

${screenMembers(o.firstList.cards)}

    /// True when the card shows only while the account has an @.
    public var needsHandle: Bool {
        switch self {
${o.firstList.cards.map((c) => `        case .${c.key}: ${c.when === "hasHandle"}`).join("\n")}
        }
    }
}

/// The one prompt card of the chat list (spec chat-list-prompt, bipe-chat/bipe#894). \`allCases\` is the queue order.
public enum BipeChatListPrompt: String, CaseIterable, Sendable {
${o.chatListPrompt.entries.map((e) => `    case ${e.key}`).join("\n")}

    /// True for tiers critical and access: the entry ignores the prompt slot and takes the card at once.
    public var preempts: Bool {
        switch self {
${o.chatListPrompt.entries.map((e) => `        case .${e.key}: ${PREEMPTS.includes(e.tier)}`).join("\n")}
        }
    }
}

public enum BipeOnboarding {
    public static let firstListMaxChats = ${o.firstList.maxChats}
    /// Hours between two slot prompts on one account (bipe-chat/bipe#200).
    public static let promptSlotHours = ${o.promptSlot.hours}
    /// Trigger pinReminderDue (bipe-chat/bipe#202): the gap in days after each step, then pinReminderThenEveryDays.
    public static let pinReminderDays = [${o.pinReminder.days.join(", ")}]
    public static let pinReminderThenEveryDays = ${o.pinReminder.thenEveryDays}
    /// Trigger voceAfterDays (bipe-chat/bipe#125): days after this phone first saw the account.
    public static let osTheftProtectionAfterDays = ${o.osTheftProtection.afterDays}
    /// Specs bring-people and bring-people-reminder (bipe-chat/bipe#752).
    public static let bringPeopleSlots = ${o.bringPeople.slots}
    public static let bringPeopleFirstCircle = ${quote(o.bringPeople.firstCircle)}
    public static let bringPeopleFollowUpEveryDays = ${o.bringPeople.followUpEveryDays}
    public static let bringPeoplePendingAfterDays = ${o.bringPeople.pendingAfterDays}
    public static let bringPeopleStopAfterDeclines = ${o.bringPeople.stopAfterDeclines}
    public static let waitlistBodyKey = ${quote(o.waitlist.body)}
    public static let waitlistPrimary = ${button(o.waitlist.primary)}
    public static let waitlistDoneKey = ${quote(o.waitlist.done)}
    public static let createdKey = ${quote(o.created)}
}
`;
  }
  // Kotlin
  const res = (key) => `R.string.${key}`;
  const optRes = (key) => (key ? res(key) : "null");
  const button = (b) => `BipeOnboardingButton(${res(b.title)}, BipeOnboardingTarget.${snake(b.to)})`;
  const screenEnum = (name, doc, list) => `/** ${doc} */
enum class ${name}(
    @StringRes val title: Int,
    @StringRes val body: Int?,
    /** The one filled button. */
    val primary: BipeOnboardingButton,
    /** Text buttons, in order under the filled button. */
    val text: List<BipeOnboardingButton>,
) {
${list.map((s) => `    ${snake(s.key)}(${res(s.title)}, ${optRes(s.body)}, ${button(s.primary)}, listOf(${s.text.map(button).join(", ")})),`).join("\n")}
    ;
`;
  return `${header}
package chat.bipe.shared.generated

import androidx.annotation.StringRes
import chat.bipe.shared.R

// First run (bipe-chat/bipe#415). Source: bipe-shared/registries/onboarding.json.

enum class BipeOnboardingTarget { ${TARGETS.map(snake).join(", ")} }

data class BipeOnboardingButton(
    @StringRes val title: Int,
    val target: BipeOnboardingTarget,
)

${screenEnum("BipeOnboardingStart", "The start screen. Exactly one variant matches each state.", o.start)}
    companion object {
        fun variant(invitePending: Boolean, inviteRequired: Boolean): BipeOnboardingStart = when {
${startTable(o).map(({ p, r, key }) => `            invitePending == ${p} && inviteRequired == ${r} -> ${snake(key)}`).join("\n")}
            else -> error("unreachable")
        }
    }
}

${screenEnum("BipeOnboardingStep", "Sign-up screens, in order.", o.steps)}}

${screenEnum("BipeOnboardingPrompt", "Prompts after the account exists.", o.prompts)}
    /** True when the prompt shares the one prompt slot ([BipeOnboarding.PROMPT_SLOT_HOURS], bipe-chat/bipe#200). */
    val usesSlot: Boolean
        get() = when (this) {
${o.prompts.map((p) => `            ${snake(p.key)} -> ${p.slot === true}`).join("\n")}
        }
}

/** Rows of "Já tenho conta", in screen order. gate: "planned:<issue>" = hidden until that issue ships; "flag:developer" = developer builds only. */
enum class BipeOnboardingRecoveryRow(
    @StringRes val title: Int,
    @StringRes val body: Int,
    /** True when the row shows only while the phone holds a synced recovery token. */
    val needsSyncedToken: Boolean,
    val gate: String?,
) {
${o.recovery.map((r) => `    ${snake(r.key)}(${res(r.title)}, ${res(r.body)}, ${r.when === "syncedToken"}, ${r.gate ? quote(r.gate) : "null"}),`).join("\n")}
    ;
}

/** Cards at the top of Conversas while it lists at most [BipeOnboarding.FIRST_LIST_MAX_CHATS] chats (bipe-chat/bipe#198). */
enum class BipeOnboardingCard(
    @StringRes val title: Int,
    @StringRes val body: Int,
    /** The one filled button. */
    val primary: BipeOnboardingButton,
    /** Text buttons, in order under the filled button. */
    val text: List<BipeOnboardingButton>,
    /** True when the card shows only while the account has an @. */
    val needsHandle: Boolean,
) {
${o.firstList.cards.map((c) => `    ${snake(c.key)}(${res(c.title)}, ${res(c.body)}, ${button(c.primary)}, listOf(${c.text.map(button).join(", ")}), ${c.when === "hasHandle"}),`).join("\n")}
    ;
}

/** The one prompt card of the chat list (spec chat-list-prompt, bipe-chat/bipe#894). [entries] order is the queue order. */
enum class BipeChatListPrompt(
    /** True for tiers critical and access: the entry ignores the prompt slot and takes the card at once. */
    val preempts: Boolean,
) {
${o.chatListPrompt.entries.map((e) => `    ${snake(e.key)}(${PREEMPTS.includes(e.tier)}),`).join("\n")}
    ;

    /** The raw key, as in registries/onboarding.json and the prompt slot memory. */
    val key: String
        get() = when (this) {
${o.chatListPrompt.entries.map((e) => `            ${snake(e.key)} -> ${quote(e.key)}`).join("\n")}
        }
}

object BipeOnboarding {
    const val FIRST_LIST_MAX_CHATS: Int = ${o.firstList.maxChats}
    /** Hours between two slot prompts on one account (bipe-chat/bipe#200). */
    const val PROMPT_SLOT_HOURS: Int = ${o.promptSlot.hours}
    /** Trigger pinReminderDue (bipe-chat/bipe#202): the gap in days after each step, then [PIN_REMINDER_THEN_EVERY_DAYS]. */
    val PIN_REMINDER_DAYS: List<Int> = listOf(${o.pinReminder.days.join(", ")})
    const val PIN_REMINDER_THEN_EVERY_DAYS: Int = ${o.pinReminder.thenEveryDays}
    /** Trigger voceAfterDays (bipe-chat/bipe#125): days after this phone first saw the account. */
    const val OS_THEFT_PROTECTION_AFTER_DAYS: Int = ${o.osTheftProtection.afterDays}
    /** Specs bring-people and bring-people-reminder (bipe-chat/bipe#752). */
    const val BRING_PEOPLE_SLOTS: Int = ${o.bringPeople.slots}
    const val BRING_PEOPLE_FIRST_CIRCLE: String = ${quote(o.bringPeople.firstCircle)}
    const val BRING_PEOPLE_FOLLOW_UP_EVERY_DAYS: Int = ${o.bringPeople.followUpEveryDays}
    const val BRING_PEOPLE_PENDING_AFTER_DAYS: Int = ${o.bringPeople.pendingAfterDays}
    const val BRING_PEOPLE_STOP_AFTER_DECLINES: Int = ${o.bringPeople.stopAfterDeclines}
    @StringRes val waitlistBody: Int = ${res(o.waitlist.body)}
    val waitlistPrimary: BipeOnboardingButton = ${button(o.waitlist.primary)}
    @StringRes val waitlistDone: Int = ${res(o.waitlist.done)}
    @StringRes val created: Int = ${res(o.created)}
}
`;
}

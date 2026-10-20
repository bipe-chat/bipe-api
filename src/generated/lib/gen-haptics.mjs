// Haptics language (ADR 0134; registries/haptics.json). Generates the haptic ids and their platform mapping.
// The players (BipeKit BipeHaptics.swift, libraries/bipe BipeHaptics.kt) are hand-written and read only this mapping.

const IOS_STYLES = { impact: ["light", "medium", "heavy", "soft", "rigid"], notification: ["success", "warning", "error"] };
const ANDROID_CONSTANTS = new Set([
  "LONG_PRESS", "VIRTUAL_KEY", "KEYBOARD_TAP", "CLOCK_TICK", "CONTEXT_CLICK", "CONFIRM", "REJECT",
  "GESTURE_START", "GESTURE_END", "GESTURE_THRESHOLD_ACTIVATE", "GESTURE_THRESHOLD_DEACTIVATE",
  "SEGMENT_TICK", "SEGMENT_FREQUENT_TICK", "TOGGLE_ON", "TOGGLE_OFF", "DRAG_START",
]);

function fail(msg) {
  throw new Error(`registry validation failed: haptics: ${msg}`);
}

export function validateHaptics(registry) {
  if (!Array.isArray(registry.haptics) || !registry.haptics.length) fail("haptics must be a non-empty list");
  const ids = new Set();
  for (const h of registry.haptics) {
    if (!/^[a-z][a-z]*$/.test(h.id ?? "") || ids.has(h.id)) fail(`id "${h.id}" must be unique lower-case letters`);
    ids.add(h.id);
    if (typeof h.meaning !== "string" || !h.meaning) fail(`${h.id}: meaning required`);
    const ios = h.ios ?? {};
    if (ios.generator === "selection") {
      if (Object.keys(ios).length !== 1) fail(`${h.id}: selection takes no arguments`);
    } else if (ios.generator === "impact") {
      if (!IOS_STYLES.impact.includes(ios.style)) fail(`${h.id}: impact style "${ios.style}"`);
      if (ios.intensity !== undefined && !(ios.intensity > 0 && ios.intensity <= 1)) fail(`${h.id}: intensity must be in (0, 1]`);
    } else if (ios.generator === "notification") {
      if (!IOS_STYLES.notification.includes(ios.type)) fail(`${h.id}: notification type "${ios.type}"`);
    } else {
      fail(`${h.id}: ios generator "${ios.generator}"`);
    }
    const android = h.android;
    if (!Array.isArray(android) || !android.length) fail(`${h.id}: android needs at least one constant`);
    android.forEach((c, i) => {
      if (!ANDROID_CONSTANTS.has(c.constant)) fail(`${h.id}: android constant "${c.constant}"`);
      if (!Number.isInteger(c.minSdk) || c.minSdk < 1) fail(`${h.id}: ${c.constant} minSdk`);
      if (i > 0 && c.minSdk >= android[i - 1].minSdk) fail(`${h.id}: android constants must go from the highest minSdk down`);
    });
    if (android.at(-1).minSdk !== 1) fail(`${h.id}: the last android constant must have minSdk 1 (works on every device)`);
    if (!Array.isArray(h.uses) || h.uses.some((u) => !/^[a-z][a-z0-9_]*$/.test(u))) fail(`${h.id}: uses must be snake_case ids`);
  }
}

const pascal = (id) => id[0].toUpperCase() + id.slice(1);

export function generateHaptics(registry, language, header, quote) {
  const { haptics } = registry;
  if (language === "swift") {
    const primitive = ({ ios }) => {
      if (ios.generator === "selection") return ".selection";
      if (ios.generator === "notification") return `.notification(.${ios.type})`;
      return `.impact(.${ios.style}, intensity: ${ios.intensity ?? 1})`;
    };
    return `${header}
#if canImport(UIKit)
import UIKit

/// The Bipe haptics language (ADR 0134). Play with \`BipeHaptics.play(_:)\`, never with a UIKit generator directly.
public enum BipeHaptic: String, CaseIterable, Sendable {
${haptics.map((h) => `    /// ${h.meaning}\n    case ${h.id}`).join("\n")}
}

public enum BipeHapticPrimitive: Equatable, Sendable {
    case selection
    case impact(UIImpactFeedbackGenerator.FeedbackStyle, intensity: CGFloat)
    case notification(UINotificationFeedbackGenerator.FeedbackType)
}

public extension BipeHaptic {
    var primitive: BipeHapticPrimitive {
        switch self {
${haptics.map((h) => `        case .${h.id}: ${primitive(h)}`).join("\n")}
        }
    }

    /// Where the apps play this haptic (registries/haptics.json \`uses\`).
    var uses: [String] {
        switch self {
${haptics.map((h) => `        case .${h.id}: [${h.uses.map(quote).join(", ")}]`).join("\n")}
        }
    }
}
#endif
`;
  }
  const constants = (h) => h.android.map((c) => `HapticConstant(HapticFeedbackConstants.${c.constant}, ${c.minSdk})`).join(", ");
  return `${header}
package io.element.android.libraries.bipe.generated

import android.annotation.SuppressLint
import android.view.HapticFeedbackConstants

/** One Android haptic constant and the lowest API level that plays it. */
data class HapticConstant(val constant: Int, val minSdk: Int)

/** The Bipe haptics language (ADR 0134). Play with \`View.bipeHaptic(_)\`, never with performHapticFeedback directly. */
@SuppressLint("InlinedApi")
enum class BipeHaptic(val constants: List<HapticConstant>, val uses: List<String>) {
${haptics.map((h) => `    /** ${h.meaning} */\n    ${pascal(h.id)}(listOf(${constants(h)}), listOf(${h.uses.map(quote).join(", ")})),`).join("\n")}
}
`;
}

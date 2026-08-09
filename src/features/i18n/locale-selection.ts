import type { LocaleBundle, LocaleSelection } from "../../lib/contracts";

export function localeSelectionsEqual(left: LocaleSelection, right: LocaleSelection): boolean {
  return (
    left.preference === right.preference &&
    left.unavailablePreference === right.unavailablePreference &&
    localeBundlesEqual(left.active, right.active) &&
    left.catalog.directory === right.catalog.directory &&
    arraysEqual(left.catalog.locales, right.catalog.locales, localeBundlesEqual) &&
    arraysEqual(
      left.catalog.issues,
      right.catalog.issues,
      (leftIssue, rightIssue) =>
        leftIssue.file === rightIssue.file && leftIssue.reason === rightIssue.reason,
    )
  );
}

function localeBundlesEqual(left: LocaleBundle, right: LocaleBundle): boolean {
  if (
    left.locale !== right.locale ||
    left.name !== right.name ||
    left.direction !== right.direction ||
    left.builtIn !== right.builtIn
  ) {
    return false;
  }
  const leftKeys = Object.keys(left.messages);
  const rightKeys = Object.keys(right.messages);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        left.messages[key as keyof typeof left.messages] ===
        right.messages[key as keyof typeof right.messages],
    )
  );
}

function arraysEqual<T>(
  left: readonly T[],
  right: readonly T[],
  itemEqual: (leftItem: T, rightItem: T) => boolean,
): boolean {
  return (
    left.length === right.length &&
    left.every((leftItem, index) => {
      const rightItem = right[index];
      return rightItem !== undefined && itemEqual(leftItem, rightItem);
    })
  );
}

/** Retains open tabs in their visual order and appends newly opened tabs. */
export function synchronizeTabOrder(
  order: readonly string[],
  availableIds: readonly string[],
): readonly string[] {
  const remainingIds = new Set(availableIds);
  const nextOrder = order.filter((id) => {
    if (!remainingIds.delete(id)) {
      return false;
    }
    return true;
  });
  nextOrder.push(...remainingIds);
  return nextOrder.length === order.length && nextOrder.every((id, index) => id === order[index])
    ? order
    : nextOrder;
}

/** Insertion points refer to the original order, from zero through its length. */
export function reorderTabAt(
  order: readonly string[],
  tabId: string,
  insertionIndex: number,
): readonly string[] {
  const sourceIndex = order.indexOf(tabId);
  if (sourceIndex < 0) {
    return order;
  }

  const boundedInsertionIndex = Math.max(0, Math.min(order.length, insertionIndex));
  const destinationIndex =
    sourceIndex < boundedInsertionIndex ? boundedInsertionIndex - 1 : boundedInsertionIndex;
  if (sourceIndex === destinationIndex) {
    return order;
  }

  const reordered = [...order];
  reordered.splice(sourceIndex, 1);
  reordered.splice(destinationIndex, 0, tabId);
  return reordered;
}

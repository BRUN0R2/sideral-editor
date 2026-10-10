export interface TabPointerPosition {
  readonly x: number;
  readonly y: number;
}

export interface TabStripBounds {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

const dragActivationDistance: number = 6;
const dragScrollEdge: number = 48;

export function hasTabDragStarted(start: TabPointerPosition, current: TabPointerPosition): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= dragActivationDistance;
}

export function isTabDropAllowed(pointer: TabPointerPosition, bounds: TabStripBounds): boolean {
  return (
    pointer.x >= bounds.left &&
    pointer.x <= bounds.right &&
    pointer.y >= bounds.top &&
    pointer.y <= bounds.bottom
  );
}

export function tabDragScrollDirection(
  pointer: TabPointerPosition,
  bounds: TabStripBounds,
): number {
  if (!isTabDropAllowed(pointer, bounds)) {
    return 0;
  }
  const edge = Math.min(dragScrollEdge, (bounds.right - bounds.left) / 2);
  if (pointer.x < bounds.left + edge) {
    return -1;
  }
  return pointer.x > bounds.right - edge ? 1 : 0;
}

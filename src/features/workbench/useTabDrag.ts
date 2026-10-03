import {
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  hasTabDragStarted,
  isTabDropAllowed,
  type TabPointerPosition,
  tabDragScrollDirection,
} from "./tab-drag-geometry";

interface TabDragSession {
  readonly tabId: string;
  readonly pointerId: number;
  readonly target: HTMLButtonElement;
  readonly start: TabPointerPosition;
  pointer: TabPointerPosition;
  dragging: boolean;
  previousFrameTime: number | null;
}

interface TabDragFeedback {
  readonly tabId: string;
  readonly dragging: boolean;
  readonly blocked: boolean;
  readonly dropIndex: number | null;
}

interface TabDragOptions {
  readonly tabIds: readonly string[];
  readonly onReorder: (tabId: string, insertionIndex: number) => void;
}

const dragScrollSpeed: number = 480;
const maximumScrollFrameDuration: number = 50;
const primaryMouseButton: number = 0;
const primaryMouseButtonMask: number = 1;

export function useTabDrag({ tabIds, onReorder }: TabDragOptions) {
  const stripRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<TabDragSession | null>(null);
  const animationRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const [feedback, setFeedback] = useState<TabDragFeedback | null>(null);

  const stopSession = useCallback(() => {
    if (animationRef.current !== null) {
      window.cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session?.target.hasPointerCapture(session.pointerId)) {
      session.target.releasePointerCapture(session.pointerId);
    }
  }, []);

  const cancelDrag = useCallback(() => {
    if (sessionRef.current !== null) {
      suppressClickRef.current = true;
    }
    stopSession();
    setFeedback(null);
  }, [stopSession]);

  const updateFeedback = useCallback(() => {
    const session = sessionRef.current;
    const strip = stripRef.current;
    if (session === null || strip === null) {
      return;
    }
    session.dragging ||= hasTabDragStarted(session.start, session.pointer);
    const bounds = strip.getBoundingClientRect();
    const blocked = !isTabDropAllowed(session.pointer, bounds);
    setFeedback({
      tabId: session.tabId,
      dragging: session.dragging,
      blocked,
      dropIndex: session.dragging && !blocked ? tabInsertionIndex(strip, session.pointer.x) : null,
    });
  }, []);

  const holdingTab = feedback !== null;
  useEffect(() => {
    if (!holdingTab) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelDrag();
      }
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        cancelDrag();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", cancelDrag);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", cancelDrag);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [cancelDrag, holdingTab]);

  const draggedTabAvailable = feedback === null || tabIds.includes(feedback.tabId);
  useEffect(() => {
    if (!draggedTabAvailable) {
      cancelDrag();
    }
  }, [cancelDrag, draggedTabAvailable]);

  useEffect(() => stopSession, [stopSession]);

  const beginDrag = (event: PointerEvent<HTMLButtonElement>, tabId: string) => {
    if (!event.isPrimary || event.button !== primaryMouseButton || sessionRef.current !== null) {
      return;
    }
    const pointer = { x: event.clientX, y: event.clientY };
    sessionRef.current = {
      tabId,
      pointerId: event.pointerId,
      target: event.currentTarget,
      start: pointer,
      pointer,
      dragging: false,
      previousFrameTime: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFeedback();

    const animateScroll = (frameTime: number) => {
      const session = sessionRef.current;
      const strip = stripRef.current;
      if (session === null || strip === null) {
        return;
      }
      const duration = Math.min(
        frameTime - (session.previousFrameTime ?? frameTime),
        maximumScrollFrameDuration,
      );
      session.previousFrameTime = frameTime;
      if (session.dragging) {
        const direction = tabDragScrollDirection(session.pointer, strip.getBoundingClientRect());
        const previousScroll = strip.scrollLeft;
        strip.scrollLeft += (direction * dragScrollSpeed * duration) / 1000;
        if (strip.scrollLeft !== previousScroll) {
          updateFeedback();
        }
      }
      animationRef.current = window.requestAnimationFrame(animateScroll);
    };
    animationRef.current = window.requestAnimationFrame(animateScroll);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current;
    if (session === null || event.pointerId !== session.pointerId) {
      return;
    }
    if ((event.buttons & primaryMouseButtonMask) === 0) {
      cancelDrag();
      return;
    }
    session.pointer = { x: event.clientX, y: event.clientY };
    updateFeedback();
    if (session.dragging) {
      event.preventDefault();
    }
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current;
    const strip = stripRef.current;
    if (session === null || strip === null || event.pointerId !== session.pointerId) {
      return;
    }
    const pointer = { x: event.clientX, y: event.clientY };
    const allowed = isTabDropAllowed(pointer, strip.getBoundingClientRect());
    const dragging = session.dragging || hasTabDragStarted(session.start, pointer);
    suppressClickRef.current = dragging || !allowed;
    if (dragging && allowed && tabIds.includes(session.tabId)) {
      onReorder(session.tabId, tabInsertionIndex(strip, pointer.x));
    }
    stopSession();
    setFeedback(null);
  };

  const handlePointerCancellation = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerId === sessionRef.current?.pointerId) {
      cancelDrag();
    }
  };

  return {
    feedback,
    beginDrag,
    stripProps: {
      ref: stripRef,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancellation,
      onLostPointerCapture: handlePointerCancellation,
      onPointerDownCapture: () => {
        suppressClickRef.current = false;
      },
      onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (suppressClickRef.current && event.detail > 0) {
          suppressClickRef.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      },
    },
  };
}

function tabInsertionIndex(container: HTMLDivElement, pointerX: number): number {
  const tabs = [...container.querySelectorAll<HTMLElement>("[data-workbench-tab]")];
  const rightToLeft = window.getComputedStyle(container).direction === "rtl";
  const insertionIndex = tabs.findIndex((tab) => {
    const bounds = tab.getBoundingClientRect();
    const midpoint = bounds.left + bounds.width / 2;
    return rightToLeft ? pointerX > midpoint : pointerX < midpoint;
  });
  return insertionIndex < 0 ? tabs.length : insertionIndex;
}

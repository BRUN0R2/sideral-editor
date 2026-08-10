export type PrimarySidebarView = "explorer" | "extensions";

export type WorkbenchResource =
  | { readonly kind: "settings" }
  | { readonly kind: "extensionDetails"; readonly extensionId: string };

export type WorkbenchSurface = { readonly kind: "editor" } | WorkbenchResource;

export interface WorkbenchNavigationState {
  readonly resources: readonly WorkbenchResource[];
  readonly surface: WorkbenchSurface;
}

export type WorkbenchNavigationAction =
  | { readonly kind: "showEditor" }
  | { readonly kind: "openSettings" }
  | { readonly kind: "openExtension"; readonly extensionId: string }
  | { readonly kind: "activateResource"; readonly resourceId: string }
  | { readonly kind: "closeResource"; readonly resourceId: string };

export const INITIAL_WORKBENCH_NAVIGATION: WorkbenchNavigationState = {
  resources: [],
  surface: { kind: "editor" },
};

export function reduceWorkbenchNavigation(
  state: WorkbenchNavigationState,
  action: WorkbenchNavigationAction,
): WorkbenchNavigationState {
  switch (action.kind) {
    case "showEditor":
      return state.surface.kind === "editor" ? state : { ...state, surface: { kind: "editor" } };
    case "openSettings":
      return openResource(state, { kind: "settings" });
    case "openExtension":
      return openResource(state, {
        kind: "extensionDetails",
        extensionId: action.extensionId,
      });
    case "activateResource": {
      const resource = state.resources.find(
        (candidate) => workbenchResourceId(candidate) === action.resourceId,
      );
      return resource === undefined || sameSurface(state.surface, resource)
        ? state
        : { ...state, surface: resource };
    }
    case "closeResource":
      return closeResource(state, action.resourceId);
  }
}

export function workbenchResourceId(resource: WorkbenchResource): string {
  return resource.kind === "settings" ? "settings" : `extension:${resource.extensionId}`;
}

function openResource(
  state: WorkbenchNavigationState,
  resource: WorkbenchResource,
): WorkbenchNavigationState {
  const resourceId = workbenchResourceId(resource);
  const alreadyOpen = state.resources.some(
    (candidate) => workbenchResourceId(candidate) === resourceId,
  );
  return {
    resources: alreadyOpen ? state.resources : [...state.resources, resource],
    surface: resource,
  };
}

function closeResource(
  state: WorkbenchNavigationState,
  resourceId: string,
): WorkbenchNavigationState {
  const closingIndex = state.resources.findIndex(
    (resource) => workbenchResourceId(resource) === resourceId,
  );
  if (closingIndex < 0) {
    return state;
  }
  const resources = state.resources.filter(
    (resource) => workbenchResourceId(resource) !== resourceId,
  );
  if (workbenchSurfaceId(state.surface) !== resourceId) {
    return { ...state, resources };
  }
  const nextSurface = resources[Math.min(closingIndex, resources.length - 1)] ?? { kind: "editor" };
  return { resources, surface: nextSurface };
}

function workbenchSurfaceId(surface: WorkbenchSurface): string | null {
  return surface.kind === "editor" ? null : workbenchResourceId(surface);
}

function sameSurface(surface: WorkbenchSurface, resource: WorkbenchResource): boolean {
  return workbenchSurfaceId(surface) === workbenchResourceId(resource);
}

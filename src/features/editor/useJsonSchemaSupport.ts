import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isDesktopRuntime, resolveJsonSchema, trustJsonSchemaLocation } from "../../lib/backend";
import type {
  JsonSchemaResolution,
  JsonSchemaTrustScope,
  WorkspaceFolderSnapshot,
} from "../../lib/contracts";
import { toApplicationError } from "../../lib/errors";
import { useI18n } from "../i18n/I18nProvider";
import { workspaceFolderForPath } from "../workspace/project-settings";
import type { EditorDocument } from "../workspace/types";
import { findJsonSchemaReference, type JsonSchemaReference } from "./json-schema-reference";
import { jsonSchemaRegistry } from "./json-schema-registry";
import { monaco } from "./monaco";

const MARKER_OWNER = "sideral-json-schema";
const pendingResolutions = new Map<string, Promise<JsonSchemaResolution>>();

interface SchemaDocument {
  readonly id: string;
  readonly path: string | null;
  readonly reference: JsonSchemaReference;
}

interface SchemaDocumentCacheEntry {
  readonly content: string;
  readonly languageId: string;
  readonly path: string | null;
  readonly schemaDocument: SchemaDocument | null;
}

interface ActiveRequest {
  readonly key: string;
  readonly token: symbol;
}

export interface JsonSchemaTrustPrompt {
  readonly uri: string;
  readonly origin: string;
}

interface QueuedTrustPrompt extends JsonSchemaTrustPrompt {
  readonly documentIds: readonly string[];
}

export interface JsonSchemaSupportController {
  readonly prompt: JsonSchemaTrustPrompt | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly cancelTrust: () => void;
  readonly grantTrust: (scope: JsonSchemaTrustScope) => Promise<void>;
}

interface JsonSchemaSupportOptions {
  readonly active: boolean;
  readonly documents: readonly EditorDocument[];
  readonly workspaceFolders: readonly WorkspaceFolderSnapshot[];
  readonly trustRevision: number;
  readonly models: RefObject<Map<string, monaco.editor.ITextModel>>;
  readonly onTrustChange: () => void;
}

export function useJsonSchemaSupport({
  active,
  documents,
  workspaceFolders,
  trustRevision,
  models,
  onTrustChange,
}: JsonSchemaSupportOptions): JsonSchemaSupportController {
  const { t } = useI18n();
  const [trustQueue, setTrustQueue] = useState<readonly QueuedTrustPrompt[]>([]);
  const [trustBusy, setTrustBusy] = useState(false);
  const [trustError, setTrustError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const mounted = useRef(false);
  const requests = useRef(new Map<string, ActiveRequest>());
  const schemaDocumentCache = useRef(new Map<string, SchemaDocumentCacheEntry>());
  const schemaDocuments = useMemo(
    () => collectSchemaDocuments(documents, schemaDocumentCache.current),
    [documents],
  );
  const schemaDocumentsById = useRef(new Map<string, SchemaDocument>());
  schemaDocumentsById.current = new Map(schemaDocuments.map((document) => [document.id, document]));

  const clearMarker = useCallback(
    (documentId: string): void => {
      const model = models.current?.get(documentId);
      if (model !== undefined) {
        monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      }
    },
    [models],
  );

  const setMarker = useCallback(
    (documentId: string, message: string): void => {
      const model = models.current?.get(documentId);
      const descriptor = schemaDocumentsById.current.get(documentId);
      if (model === undefined || descriptor === undefined) {
        return;
      }
      const start = model.getPositionAt(descriptor.reference.offset);
      const end = model.getPositionAt(descriptor.reference.offset + descriptor.reference.length);
      monaco.editor.setModelMarkers(model, MARKER_OWNER, [
        {
          severity: monaco.MarkerSeverity.Warning,
          message,
          source: "Sideral JSON Schema",
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        },
      ]);
    },
    [models],
  );

  useEffect(() => {
    mounted.current = true;
    const activeRequests = requests.current;
    return () => {
      mounted.current = false;
      for (const documentId of activeRequests.keys()) {
        jsonSchemaRegistry.delete(documentId);
      }
      activeRequests.clear();
    };
  }, []);

  useEffect(() => {
    const currentDocuments = new Map(schemaDocuments.map((document) => [document.id, document]));
    const activeIds = new Set(currentDocuments.keys());

    for (const documentId of [...requests.current.keys()]) {
      if (!activeIds.has(documentId)) {
        requests.current.delete(documentId);
        jsonSchemaRegistry.delete(documentId);
        clearMarker(documentId);
      }
    }
    setTrustQueue((current) => {
      const next = current
        .map((prompt) => ({
          ...prompt,
          documentIds: prompt.documentIds.filter((documentId) => activeIds.has(documentId)),
        }))
        .filter((prompt) => prompt.documentIds.length > 0);
      return trustQueuesEqual(current, next) ? current : next;
    });

    if (!active || !isDesktopRuntime()) {
      return;
    }

    for (const descriptor of currentDocuments.values()) {
      const workspaceRootPath =
        workspaceFolderForPath(workspaceFolders, descriptor.path)?.path ?? null;
      const key = JSON.stringify([
        descriptor.reference.uri,
        descriptor.path,
        workspaceRootPath,
        trustRevision,
        retryGeneration,
      ]);
      if (requests.current.get(descriptor.id)?.key === key) {
        continue;
      }

      const token = Symbol(descriptor.id);
      requests.current.set(descriptor.id, { key, token });
      jsonSchemaRegistry.delete(descriptor.id);
      clearMarker(descriptor.id);

      void resolveOnce(descriptor.reference.uri, descriptor.path, workspaceRootPath)
        .then((resolution) => {
          if (!isCurrentRequest(requests.current, descriptor.id, token) || !mounted.current) {
            return;
          }
          if (resolution.status === "resolved") {
            jsonSchemaRegistry.set(descriptor.id, resolution.schemas);
            clearMarker(descriptor.id);
            return;
          }
          setTrustQueue((current) => enqueueTrustPrompt(current, resolution, descriptor.id));
        })
        .catch((error: unknown) => {
          if (!isCurrentRequest(requests.current, descriptor.id, token) || !mounted.current) {
            return;
          }
          const reason = toApplicationError(error).message;
          setMarker(descriptor.id, t("editor.schemaLoadFailed", { reason }));
        });
    }
  }, [
    active,
    clearMarker,
    retryGeneration,
    schemaDocuments,
    setMarker,
    t,
    trustRevision,
    workspaceFolders,
  ]);

  const cancelTrust = useCallback((): void => {
    if (trustBusy) {
      return;
    }
    const prompt = trustQueue[0];
    if (prompt === undefined) {
      return;
    }
    for (const documentId of prompt.documentIds) {
      setMarker(documentId, t("editor.schemaTrustDeclined", { uri: prompt.uri }));
    }
    setTrustError(null);
    setTrustQueue((current) => current.slice(1));
  }, [setMarker, t, trustBusy, trustQueue]);

  const grantTrust = useCallback(
    async (scope: JsonSchemaTrustScope): Promise<void> => {
      const prompt = trustQueue[0];
      if (prompt === undefined || trustBusy) {
        return;
      }
      setTrustBusy(true);
      setTrustError(null);
      try {
        await trustJsonSchemaLocation(prompt.uri, scope);
        if (!mounted.current) {
          return;
        }
        setTrustQueue((current) =>
          current.filter((item) =>
            scope === "origin" ? item.origin !== prompt.origin : item.uri !== prompt.uri,
          ),
        );
        setRetryGeneration((current) => current + 1);
        onTrustChange();
      } catch (error: unknown) {
        if (mounted.current) {
          setTrustError(toApplicationError(error).message);
        }
      } finally {
        if (mounted.current) {
          setTrustBusy(false);
        }
      }
    },
    [onTrustChange, trustBusy, trustQueue],
  );

  return {
    prompt: trustQueue[0] ?? null,
    busy: trustBusy,
    error: trustError,
    cancelTrust,
    grantTrust,
  };
}

function trustQueuesEqual(
  left: readonly QueuedTrustPrompt[],
  right: readonly QueuedTrustPrompt[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (prompt, index) =>
        prompt === right[index] ||
        (prompt.uri === right[index]?.uri &&
          prompt.origin === right[index]?.origin &&
          prompt.documentIds.length === right[index]?.documentIds.length &&
          prompt.documentIds.every(
            (documentId, documentIndex) => documentId === right[index]?.documentIds[documentIndex],
          )),
    )
  );
}

function collectSchemaDocuments(
  documents: readonly EditorDocument[],
  cache: Map<string, SchemaDocumentCacheEntry>,
): readonly SchemaDocument[] {
  const activeIds = new Set(documents.map((document) => document.id));
  const result: SchemaDocument[] = [];
  for (const document of documents) {
    let cached = cache.get(document.id);
    if (
      cached === undefined ||
      cached.content !== document.content ||
      cached.languageId !== document.languageId ||
      cached.path !== document.path
    ) {
      const reference =
        document.languageId === "json" ? findJsonSchemaReference(document.content) : null;
      cached = {
        content: document.content,
        languageId: document.languageId,
        path: document.path,
        schemaDocument:
          reference === null ? null : { id: document.id, path: document.path, reference },
      };
      cache.set(document.id, cached);
    }
    if (cached.schemaDocument !== null) {
      result.push(cached.schemaDocument);
    }
  }
  for (const documentId of cache.keys()) {
    if (!activeIds.has(documentId)) {
      cache.delete(documentId);
    }
  }
  return result;
}

function resolveOnce(
  schemaUri: string,
  documentPath: string | null,
  workspaceRootPath: string | null,
): Promise<JsonSchemaResolution> {
  const key = JSON.stringify([schemaUri, documentPath, workspaceRootPath]);
  const pending = pendingResolutions.get(key);
  if (pending !== undefined) {
    return pending;
  }
  const request = resolveJsonSchema(schemaUri, documentPath, workspaceRootPath).finally(() => {
    if (pendingResolutions.get(key) === request) {
      pendingResolutions.delete(key);
    }
  });
  pendingResolutions.set(key, request);
  return request;
}

function isCurrentRequest(
  requests: ReadonlyMap<string, ActiveRequest>,
  documentId: string,
  token: symbol,
): boolean {
  return requests.get(documentId)?.token === token;
}

function enqueueTrustPrompt(
  queue: readonly QueuedTrustPrompt[],
  resolution: Extract<JsonSchemaResolution, { readonly status: "trustRequired" }>,
  documentId: string,
): readonly QueuedTrustPrompt[] {
  const index = queue.findIndex((prompt) => prompt.uri === resolution.uri);
  if (index < 0) {
    return [
      ...queue,
      {
        uri: resolution.uri,
        origin: resolution.origin,
        documentIds: [documentId],
      },
    ];
  }
  const prompt = queue[index];
  if (prompt === undefined || prompt.documentIds.includes(documentId)) {
    return queue;
  }
  return queue.map((item, currentIndex) =>
    currentIndex === index ? { ...item, documentIds: [...item.documentIds, documentId] } : item,
  );
}

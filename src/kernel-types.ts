/**
 * Boundary types duplicated from kernel surfaces this plugin depends on at
 * compile time. Kept deliberately narrow — structural typing lets the real
 * kernel implementations (EntityRefBus, KnowledgeGraph, LocalSubAgentTool)
 * satisfy these interfaces without the plugin importing from kernel paths.
 *
 * When S+8 extracts `@omadia/knowledge-graph`, the KG-related types
 * here should be replaced by imports from that package (and this plugin's
 * manifest should declare `requires: ["knowledgeGraph@^1"]`). Until then,
 * this file is the single source of cross-boundary shapes for the
 * Confluence-plugin.
 */

// ---------------------------------------------------------------------------
// EntityRef + EntityRefBus
// ---------------------------------------------------------------------------

/** Mirrors kernel `src/types/entityRef.ts`. */
export interface EntityRef {
  system: 'odoo' | 'confluence';
  model: string;
  id: string | number;
  displayName?: string;
  /**
   * `'read'` for every tool that observes a page; `'write'` for the
   * create/update/comment tools (gated behind `confluence_write_enabled`).
   *
   * NOTE: the kernel-side `@omadia/plugin-api` `EntityRef.op` is still typed
   * `'read'` only (see `plugin-api/src/entityRef.ts`). `EntityRefBus.publish`
   * does NOT validate `op` at runtime — it just forwards the object — so
   * publishing `'write'` works today. The OSS-core union widening is a
   * separate, compile-time-only change tracked outside this plugin; once it
   * lands, kernel consumers (transcript parser etc.) can branch on `'write'`.
   */
  op: 'read' | 'write';
}

/** Narrow surface of the kernel EntityRefBus — plugin only publishes. */
export interface EntityRefBus {
  publish(ref: EntityRef): void;
}

// ---------------------------------------------------------------------------
// Knowledge-graph ingest payloads
// ---------------------------------------------------------------------------

export interface EntityIngest {
  system: 'odoo' | 'confluence';
  model: string;
  id: string | number;
  displayName?: string;
  extras?: Record<string, unknown>;
}

export interface EntityIngestResult {
  entityIds: string[];
  inserted: number;
  updated: number;
}

/**
 * Narrow projection of the kernel KnowledgeGraph surface used by this plugin
 * (ConfluenceEntitySync). Structurally satisfied by the full kernel
 * interface.
 */
export interface KnowledgeGraph {
  ingestEntities(entities: EntityIngest[]): Promise<EntityIngestResult>;
}

// ---------------------------------------------------------------------------
// LocalSubAgentTool — return shape of createConfluenceTools factory
// ---------------------------------------------------------------------------

export interface LocalSubAgentToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface LocalSubAgentTool {
  spec: LocalSubAgentToolSpec;
  handle(input: unknown): Promise<string>;
}

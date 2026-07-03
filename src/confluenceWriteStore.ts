import { randomUUID } from 'node:crypto';

/**
 * Server-side staging store for the two-phase write/confirm flow.
 *
 * A `prepare*` tool validates an operation, renders a human-readable preview,
 * and stages the *already-validated* operation descriptor here behind an
 * opaque token. The sub-agent only ever sees the token + the preview — never
 * a handle it can mutate. `confluence_commit_write(token)` then executes the
 * stored descriptor verbatim, so the content the operator confirmed is
 * byte-for-byte the content that gets written: the LLM cannot drift the
 * payload between preview and commit.
 *
 * Entries are single-use (taken on commit) and expire after `ttlMs`
 * (default 5 min) so an un-confirmed preview cannot be replayed later.
 */

export type PendingWrite =
  | { kind: 'create'; title: string; bodyStorage: string; parentId?: string }
  | {
      kind: 'update';
      id: string;
      title: string;
      bodyStorage: string;
      nextVersion: number;
      fromVersion: number;
    }
  | { kind: 'comment'; pageId: string; bodyStorage: string };

interface StoredWrite {
  write: PendingWrite;
  preview: string;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class ConfluenceWriteStore {
  private readonly entries = new Map<string, StoredWrite>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Stage a validated operation; returns the opaque confirmation token. */
  stage(write: PendingWrite, preview: string): string {
    this.gc();
    const token = randomUUID();
    this.entries.set(token, {
      write,
      preview,
      expiresAt: Date.now() + this.ttlMs,
    });
    return token;
  }

  /** Single-use lookup: removes the entry and returns it only if unexpired. */
  take(token: string): StoredWrite | undefined {
    this.gc();
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    this.entries.delete(token);
    if (entry.expiresAt < Date.now()) return undefined;
    return entry;
  }

  /** Test/diagnostics helper — number of live staged writes. */
  get size(): number {
    this.gc();
    return this.entries.size;
  }

  private gc(): void {
    const now = Date.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(token);
    }
  }
}

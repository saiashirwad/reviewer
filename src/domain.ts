import type { Settings } from "./Settings.ts";

export interface RepositoryRef {
  readonly owner: string;
  readonly repository: string;
}

export interface PullRef extends RepositoryRef {
  readonly number: number;
}

export interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface Job extends PullRef {
  /** The webhook saw this head. Omitted for manual `/review`, which uses the current head. */
  readonly headSha?: string;
  readonly settings: Settings;
}

export type Result =
  | { readonly _tag: "Published"; readonly headSha: string; readonly findings: number }
  | { readonly _tag: "Skipped"; readonly reason: string };

export const skipped = (reason: string): Result => ({ _tag: "Skipped", reason });

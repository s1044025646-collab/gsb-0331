export const SUBSET_VERSION = 'der-subset-1';

export const DEFAULT_LIMITS = {
  maxInputBytes: 1_048_576,
  maxDepth: 64,
} as const;

export interface Limits {
  maxInputBytes: number;
  maxDepth: number;
}

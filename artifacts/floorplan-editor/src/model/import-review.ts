import type { MigrationCandidate } from './types';

export type ImportReview = {
  sourceVersion: 1 | 2;
  sourceJson: string;
  candidates: MigrationCandidate[];
};

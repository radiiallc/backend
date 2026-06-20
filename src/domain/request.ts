// Human-facing request reference derived from the Request.seq autoincrement.
// Pure + shared by apps/api request reads (buyer + admin) so the REQ-#### a
// buyer sees and the one admin sees never drift.
export const REQ_REFERENCE_START = 1001;
export const REQ_REFERENCE_STEP = 3;

export function formatRequestReference(seq: number): string {
  return `REQ-${REQ_REFERENCE_START + (seq - 1) * REQ_REFERENCE_STEP}`;
}

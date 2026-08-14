export const REQ_REFERENCE_START = 1001;
export const REQ_REFERENCE_STEP = 3;

export function formatRequestReference(seq: number): string {
  return `REQ-${REQ_REFERENCE_START + (seq - 1) * REQ_REFERENCE_STEP}`;
}

// Pure PRNG math helpers.
// SHA-256("server-client-nonce") → first 8 hex chars → uint32 / 0xFFFFFFFF ∈ [0,1).

export interface PrngRow {
  tick: number;
  nonce: number;
  hexFrag: string;
  decimal: number; // 0..1
  digit: number; // last digit 0..9 derived from decimal (floor(decimal*10))
}

const HEX = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    const b = bytes[i];
    out += HEX[b >>> 4] + HEX[b & 0x0f];
  }
  return out;
}

export async function prngStep(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
): Promise<{ hexFrag: string; decimal: number }> {
  const msg = `${serverSeed}-${clientSeed}-${nonce}`;
  const buf = new TextEncoder().encode(msg);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const view = new Uint8Array(digest);
  const hexFrag = bytesToHex(view, 4); // first 8 hex chars = 4 bytes
  // Assemble 32-bit unsigned int from the 4 bytes (big-endian, matches hex order).
  const u32 =
    ((view[0] << 24) | (view[1] << 16) | (view[2] << 8) | view[3]) >>> 0;
  const decimal = u32 / 0xffffffff;
  return { hexFrag, decimal };
}

/**
 * Generate `steps` deterministic PRNG rows starting at `startNonce`.
 * Pre-allocates the result array; no dynamic push inside the loop.
 */
export async function generatePrng(
  serverSeed: string,
  clientSeed: string,
  startNonce: number,
  steps: number,
): Promise<PrngRow[]> {
  const n = Math.max(0, Math.min(1000, steps | 0));
  const rows: PrngRow[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const nonce = startNonce + i;
    const { hexFrag, decimal } = await prngStep(serverSeed, clientSeed, nonce);
    rows[i] = {
      tick: i + 1,
      nonce,
      hexFrag,
      decimal,
      digit: Math.min(9, Math.floor(decimal * 10)),
    };
  }
  return rows;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));

function base58Decode(input: string): Uint8Array {
  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === "1") leadingZeros++;

  let value = 0n;
  for (const char of input) {
    const digit = BASE58_MAP.get(char);
    if (digit === undefined) throw new Error(`base58Decode: invalid character "${char}"`);
    value = value * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }

  return new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes]);
}

function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let out = "";
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }

  return "1".repeat(leadingZeros) + out;
}

// CIDv0 is a base58-encoded multihash: 0x12 (sha2-256) + 0x20 (32 bytes) + the 32-byte digest.
// Stripping that fixed 2-byte prefix leaves exactly 32 bytes, so it fits in a Solidity bytes32
// without re-deriving the hash.
const CIDV0_PREFIX = [0x12, 0x20];

export function cidToBytes32(cid: string): `0x${string}` {
  const bytes = base58Decode(cid);
  if (bytes.length !== 34 || bytes[0] !== CIDV0_PREFIX[0] || bytes[1] !== CIDV0_PREFIX[1]) {
    throw new Error(`cidToBytes32: "${cid}" is not a CIDv0 (sha2-256) CID`);
  }
  return `0x${[...bytes.slice(2)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function bytes32ToCid(hash: `0x${string}`): string {
  const hex = hash.slice(2);
  const digest: number[] = [];
  for (let i = 0; i < hex.length; i += 2) digest.push(parseInt(hex.slice(i, i + 2), 16));
  return base58Encode(new Uint8Array([...CIDV0_PREFIX, ...digest]));
}

// Tiny stack VM, make.fun tiny-stack-vm-01 (ISA v1), from the ISA spec alone.
// One run: /input/<id>/program.bin + input.bin -> /output/<id>/stdout.bin + exit.txt.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const L = new Uint8Array(256); // instruction length by opcode; 0 = no opcode
for (const o of [0, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 33, 34, 52, 64, 65, 80, 81, 82, 83]) L[o] = 1;
L[1] = 2; // PUSH8 (1-byte immediate)
for (const o of [48, 49, 50, 51]) L[o] = 3; // JMP JZ JNZ CALL (2-byte)
L[2] = 5; // PUSH32 (4-byte)
// Binary ops (a b -- r), b is the top. DIV/MOD/DIVU/MODU trap 4 on b = 0
// (checked by the caller). (a/b)|0 wraps INT_MIN/-1 to itself; MOD's sign
// follows a; DIVU/MODU/LTU read operands unsigned; SHRU is logical.
const F: Record<number, (a: number, b: number) => number> = {
  16: (a, b) => (a + b) | 0, 17: (a, b) => (a - b) | 0, 18: Math.imul,
  19: (a, b) => (a / b) | 0, 20: (a, b) => (a % b) | 0,
  21: (a, b) => ((a >>> 0) / (b >>> 0)) | 0, 22: (a, b) => ((a >>> 0) % (b >>> 0)) | 0,
  24: (a, b) => a & b, 25: (a, b) => a | b, 26: (a, b) => a ^ b,
  28: (a, b) => a << (b & 31), 29: (a, b) => a >> (b & 31),
  30: (a, b) => (a >>> (b & 31)) | 0,
  32: (a, b) => a === b ? 1 : 0, 33: (a, b) => a < b ? 1 : 0,
  34: (a, b) => (a >>> 0) < (b >>> 0) ? 1 : 0,
};
function run(p: Buffer, g: Buffer): { exit: number; bytes: Uint8Array } {
  const s = new Int32Array(256); let q = 0; // data stack, sp
  const c = new Int32Array(64); let n = 0; // call stack, cp
  const m = new Int32Array(256); // memory, all words start 0
  const o = new Uint8Array(65536); let k = 0; // output, length
  let j = 0, pc = 0, t = 0; // input position, pc, steps executed
  const d = (e: number) => ({ exit: e, bytes: o.subarray(0, k) });
  for (;;) {
    if (t >= 1000000) return d(10); // step limit, checked first
    if (pc < 0 || pc >= p.length) return d(9); // pc outside program
    const op = p[pc], l = L[op];
    if (!l) return d(5); // unknown opcode
    if (pc + l > p.length) return d(9); // immediate cut off by end
    t++;
    // Immediates are little-endian; len 5's <<24 already makes it signed.
    let a = 0;
    if (l === 2) a = p[pc + 1];
    else if (l === 3) a = p[pc + 1] | (p[pc + 2] << 8);
    else if (l === 5) a = p[pc + 1] | (p[pc + 2] << 8) | (p[pc + 3] << 16) | (p[pc + 4] << 24);
    const x = pc + l; pc = x; // jumps below override this
    let u: number, v: number, w: string;
    switch (op) {
      case 0: return d(0); // HALT
      case 1: // PUSH8, sign-extended
        if (q >= 256) return d(3);
        s[q++] = (a << 24) >> 24; break;
      case 2: // PUSH32
        if (q >= 256) return d(3);
        s[q++] = a; break;
      case 3: // POP
        if (q < 1) return d(2);
        q--; break;
      case 4: // DUP
        if (q < 1) return d(2);
        if (q >= 256) return d(3);
        s[q] = s[q - 1]; q++; break;
      case 5: // SWAP (a b -- b a)
        if (q < 2) return d(2);
        v = s[q - 1]; s[q - 1] = s[q - 2]; s[q - 2] = v; break;
      case 6: // OVER (a b -- a b a)
        if (q < 2) return d(2);
        if (q >= 256) return d(3);
        s[q] = s[q - 2]; q++; break;
      case 7: // ROT (a b c -- b c a)
        if (q < 3) return d(2);
        v = s[q - 3]; s[q - 3] = s[q - 2]; s[q - 2] = s[q - 1]; s[q - 1] = v; break;
      case 16: case 17: case 18: case 19: case 20: case 21: case 22:
      case 24: case 25: case 26: case 28: case 29: case 30: case 32: case 33: case 34:
        if (q < 2) return d(2);
        v = s[--q]; u = s[q - 1];
        if (v === 0 && op > 18 && op < 23) return d(4); // division by zero
        s[q - 1] = F[op](u, v); break;
      case 23: // NEG, wraps
        if (q < 1) return d(2);
        s[q - 1] = (-s[q - 1]) | 0; break;
      case 27: // NOT
        if (q < 1) return d(2);
        s[q - 1] = ~s[q - 1]; break;
      case 48: // JMP: pc = next + signed 16-bit offset
        pc = x + ((a << 16) >> 16); break;
      case 49: // JZ
        if (q < 1) return d(2);
        if (s[--q] === 0) pc = x + ((a << 16) >> 16); break;
      case 50: // JNZ
        if (q < 1) return d(2);
        if (s[--q] !== 0) pc = x + ((a << 16) >> 16); break;
      case 51: // CALL: 64 return addresses held already traps 7
        if (n >= 64) return d(7);
        c[n++] = x; pc = a; break; // unsigned 16-bit target
      case 52: // RET: empty call stack traps 8
        if (n === 0) return d(8);
        pc = c[--n]; break;
      case 64: // LOAD: address outside 0..255 traps 6
        if (q < 1) return d(2);
        u = s[q - 1];
        if (u < 0 || u > 255) return d(6);
        s[q - 1] = m[u]; break;
      case 65: // STORE (v addr --): address outside 0..255 traps 6
        if (q < 2) return d(2);
        u = s[--q];
        if (u < 0 || u > 255) return d(6);
        m[u] = s[--q]; break;
      case 80: // PRINT: decimal ASCII, '-' when negative, nothing else
        if (q < 1) return d(2);
        w = String(s[--q]);
        if (k + w.length > 65536) return d(11); // output limit, writes none
        for (let i = 0; i < w.length; i++) o[k++] = w.charCodeAt(i);
        break;
      case 81: // PUTC: one byte, v AND 255
        if (q < 1) return d(2);
        if (k + 1 > 65536) return d(11);
        o[k++] = s[--q] & 255; break;
      case 82: // IN: next input byte, -1 once the input is used up
        if (q >= 256) return d(3);
        s[q++] = j < g.length ? g[j++] : -1; break;
      case 83: // EXIT: exit with code v AND 255
        if (q < 1) return d(2);
        return d(s[--q] & 255);
    }
  }
}
for (const id of readdirSync(I).sort()) {
  let p: Buffer, g: Buffer;
  try {
    p = readFileSync(join(I, id, 'program.bin'));
    g = readFileSync(join(I, id, 'input.bin'));
  } catch { continue; } // not an instance directory
  const r = run(p, g);
  const od = join(O, id);
  mkdirSync(od, { recursive: true });
  writeFileSync(join(od, 'stdout.bin'), r.bytes);
  writeFileSync(join(od, 'exit.txt'), String(r.exit) + '\n');
}

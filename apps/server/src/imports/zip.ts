import { inflateRawSync } from "node:zlib";
import { strFromU8 } from "fflate";
import { badRequest } from "../http/errors";

/** A file in a zip; `read` inflates it, at most to the size it declares. */
export type ZipEntry = { name: string; size: number; read: () => Uint8Array };

const damaged = () => badRequest("This is not a zip file, or it is damaged");

/**
 * Lists the files of a zip (folders left out) from its central directory.
 * The declared sizes count against `maxBytes` before anything is inflated,
 * and inflating stops as soon as a file grows past its declared size, so a
 * zip bomb costs no more than the sizes it declares.
 */
export function readZip(data: Uint8Array, limits: { maxFiles: number; maxBytes: number }): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const u64 = (offset: number) => u32(offset) + u32(offset + 4) * 2 ** 32;

  try {
    // End of central directory: the last 22 bytes plus a comment of at most 64 KB.
    let end = data.length - 22;
    while (end >= 0 && u32(end) !== 0x06054b50) {
      if (data.length - end > 22 + 0xffff) throw damaged();
      end -= 1;
    }
    if (end < 0) throw damaged();
    let count = u16(end + 10);
    let offset = u32(end + 16);
    if (count === 0xffff || offset === 0xffffffff) {
      // Zip64: the locator before it points to the zip64 end record.
      const record = u64(end - 12);
      if (u32(end - 20) !== 0x07064b50 || u32(record) !== 0x06064b50) throw damaged();
      count = u64(record + 32);
      offset = u64(record + 48);
    }

    const entries: ZipEntry[] = [];
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      if (u32(offset) !== 0x02014b50) throw damaged();
      const flags = u16(offset + 8);
      const method = u16(offset + 10);
      let compressed = u32(offset + 20);
      let size = u32(offset + 24);
      const nameLength = u16(offset + 28);
      const extraLength = u16(offset + 30);
      let local = u32(offset + 42);
      const name = strFromU8(data.subarray(offset + 46, offset + 46 + nameLength), !(flags & 0x800));
      if (size === 0xffffffff || compressed === 0xffffffff || local === 0xffffffff) {
        // Zip64 extra field: the 8-byte values that did not fit, in this order.
        let field = offset + 46 + nameLength;
        const extraEnd = field + extraLength;
        while (field + 4 <= extraEnd && u16(field) !== 0x0001) field += 4 + u16(field + 2);
        if (field + 4 > extraEnd) throw damaged();
        let value = field + 4;
        const next = () => {
          const read = u64(value);
          value += 8;
          return read;
        };
        if (size === 0xffffffff) size = next();
        if (compressed === 0xffffffff) compressed = next();
        if (local === 0xffffffff) local = next();
      }
      offset += 46 + nameLength + extraLength + u16(offset + 32);
      if (name.endsWith("/")) continue;

      if (entries.length >= limits.maxFiles) {
        throw badRequest(`A zip may hold at most ${limits.maxFiles} files`);
      }
      total += size;
      if (total > limits.maxBytes) throw badRequest("The unpacked files are too large");
      if (u32(local) !== 0x04034b50) throw damaged();
      const start = local + 30 + u16(local + 26) + u16(local + 28);
      if (start + compressed > data.length) throw damaged();
      const stored = data.subarray(start, start + compressed);
      entries.push({ name, size, read: () => inflate(method, stored, size) });
    }
    return entries;
  } catch (error) {
    if (error instanceof RangeError) throw damaged();
    throw error;
  }
}

function inflate(method: number, stored: Uint8Array, size: number): Uint8Array {
  if (method === 0) {
    if (stored.length !== size) throw damaged();
    return stored;
  }
  if (method !== 8) throw damaged();
  try {
    // Throws as soon as the output passes the declared size (zip bombs).
    return inflateRawSync(stored, { maxOutputLength: Math.max(size, 1) });
  } catch {
    throw damaged();
  }
}

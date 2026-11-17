import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, zipSync } from "fflate";
import { zipBomb } from "../test/zip-bomb";
import { readZip } from "./zip";

const limits = { maxFiles: 10, maxBytes: 1024 * 1024 };

function read(data: Uint8Array, options = limits) {
  return Object.fromEntries(readZip(data, options).map((entry) => [entry.name, strFromU8(entry.read())]));
}

/** One deflated file whose sizes and offset are in a zip64 extra field, as some tools write them. */
function zip64(name: string, text: string): Uint8Array {
  const data = deflateRawSync(Buffer.from(text));
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(fileName.length, 26);
  const extra = Buffer.alloc(28);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(BigInt(text.length), 4);
  extra.writeBigUInt64LE(BigInt(data.length), 12);
  extra.writeBigUInt64LE(0n, 20);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0xffffffff, 20);
  central.writeUInt32LE(0xffffffff, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt32LE(0xffffffff, 42);
  const directoryOffset = local.length + fileName.length + data.length;
  const directory = Buffer.concat([central, fileName, extra]);
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeBigUInt64LE(1n, 24);
  record.writeBigUInt64LE(1n, 32);
  record.writeBigUInt64LE(BigInt(directory.length), 40);
  record.writeBigUInt64LE(BigInt(directoryOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(directoryOffset + directory.length), 8);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  return new Uint8Array(Buffer.concat([local, fileName, data, directory, record, locator, end]));
}

describe("zip reader", () => {
  it("reads deflated and stored files and leaves out folders", () => {
    const zip = zipSync({
      "docs/": new Uint8Array(0),
      "docs/a.md": strToU8("# A\n".repeat(100)),
      "docs/b.md": [strToU8("# B\n"), { level: 0 }],
      "Über.md": strToU8("ü"),
    });
    expect(read(zip)).toEqual({ "docs/a.md": "# A\n".repeat(100), "docs/b.md": "# B\n", "Über.md": "ü" });
  });

  it("reads zip64 files", () => {
    expect(read(zip64("guides/vpn.md", "# VPN\n"))).toEqual({ "guides/vpn.md": "# VPN\n" });
  });

  it("checks the number of files and their declared sizes before inflating anything", () => {
    const files = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`${index}.md`, strToU8("x")]));
    expect(() => readZip(zipSync(files), limits)).toThrow("A zip may hold at most 10 files");
    const large = zipSync({ "a.md": new Uint8Array(600 * 1024), "b.md": new Uint8Array(600 * 1024) });
    expect(() => readZip(large, limits)).toThrow("The unpacked files are too large");
  });

  it("stops inflating a file at its declared size", () => {
    const bomb = zipBomb({ entries: 1, inflatedBytes: 64 * 1024 * 1024, declaredBytes: 100 });
    const [entry] = readZip(bomb, limits);
    expect(entry).toMatchObject({ name: "p1.md", size: 100 });
    const start = performance.now();
    expect(() => entry!.read()).toThrow("This is not a zip file, or it is damaged");
    expect(performance.now() - start).toBeLessThan(100);
  });

  it("refuses data that is not a zip", () => {
    const zip = zipSync({ "a.md": strToU8("# A\n") });
    for (const data of [strToU8("hello"), new Uint8Array(0), zip.slice(0, zip.length - 30), zip.slice(10)]) {
      expect(() => readZip(data, limits).map((entry) => entry.read())).toThrow(
        "This is not a zip file, or it is damaged",
      );
    }
  });
});

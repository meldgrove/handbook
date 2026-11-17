import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { FileInfo } from "@knowledge/shared/api/spaces";
import { INLINE_IMAGE_TYPES } from "@knowledge/shared/limits";
import { config } from "../config";
import { getDb, type Db } from "../db/client";
import { files } from "../db/schema";
import { badRequest } from "../http/errors";
import { logger } from "../logger";

export type FileRow = typeof files.$inferSelect;

const root = () => path.resolve(config().FILES_DIR);

/** Where a stored file lives; keys are generated, never taken from a request. */
function filePath(storageKey: string): string {
  if (!/^[0-9a-f]{2}\/[0-9a-f-]{36}$/.test(storageKey)) throw new Error("Invalid storage key");
  return path.join(root(), storageKey);
}

/** A safe file name: no paths, no control characters, at most 200 characters. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = [...base]
    .filter(
      (character) =>
        character.charCodeAt(0) >= 32 &&
        character.charCodeAt(0) !== 127 &&
        !['"', "<", ">", "[", "]", "(", ")"].includes(character),
    )
    .join("")
    .trim()
    .slice(-200);
  return clean || "file";
}

export function isInlineImage(contentType: string): boolean {
  return (INLINE_IMAGE_TYPES as readonly string[]).includes(contentType);
}

export function fileUrl(row: Pick<FileRow, "id" | "name">): string {
  return `/files/${row.id}/${encodeURIComponent(row.name)}`;
}

export function toFileInfo(row: FileRow): FileInfo {
  const url = fileUrl(row);
  const label = row.name.replace(/[[\]]/g, "");
  return {
    id: row.id,
    name: row.name,
    contentType: row.contentType,
    size: row.size,
    url,
    markdown: isInlineImage(row.contentType) ? `![${label}](${url})` : `[${label}](${url})`,
  };
}

/** Stores an upload of a space. Pages refer to it by its URL. */
export async function saveUpload(spaceId: string, uploaderId: string | null, file: File): Promise<FileInfo> {
  const name = cleanFilename(file.name);
  if (file.size === 0) throw badRequest("The file is empty");
  if (file.size > config().MAX_UPLOAD_MB * 1024 * 1024) {
    throw badRequest(`The file is larger than ${config().MAX_UPLOAD_MB} MB`);
  }
  const id = randomUUID();
  const storageKey = `${id.slice(0, 2)}/${id}`;
  const target = filePath(storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(await file.arrayBuffer()), { flag: "wx" });
  try {
    const contentType = (file.type || "application/octet-stream")
      .toLowerCase()
      .split(";")[0]!
      .trim()
      .slice(0, 100);
    const [row] = await getDb()
      .insert(files)
      .values({ id, spaceId, name, contentType, size: file.size, storageKey, uploadedById: uploaderId })
      .returning();
    return toFileInfo(row!);
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
}

export function readStoredFile(row: FileRow) {
  return createReadStream(filePath(row.storageKey));
}

/**
 * Removes uploads older than a day that no live page, revision or change
 * set mentions (`/files/<id>/`).
 */
export async function pruneUnusedUploads(db: Db): Promise<number> {
  const rows = await db
    .select()
    .from(files)
    .where(
      sql`${files.createdAt} < now() - interval '1 day'
        and not exists (select 1 from pages p where strpos(p.markdown, '/files/' || ${files.id}::text || '/') > 0)
        and not exists (select 1 from page_revisions r where strpos(r.markdown, '/files/' || ${files.id}::text || '/') > 0)
        and not exists (select 1 from change_set_items i where strpos(coalesce(i.markdown, ''), '/files/' || ${files.id}::text || '/') > 0)`,
    )
    .limit(500);
  for (const row of rows) {
    await rm(filePath(row.storageKey), { force: true }).catch((error: unknown) =>
      logger.warn({ err: error, fileId: row.id }, "could not remove an unused upload"),
    );
    await db.delete(files).where(eq(files.id, row.id));
  }
  return rows.length;
}

import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ImportResult } from "@knowledge/shared/api/spaces";
import { MAX_IMPORT_BYTES, MAX_IMPORT_FILES } from "@knowledge/shared/limits";
import {
  BUILT_IN_KEYS,
  PAGE_TYPE_KEY_PATTERN,
  canonicalPageFile,
  pageTypeDefinitionSchema,
  propertyDefinitionSchema,
  readFrontmatterValues,
  splitFrontmatter,
  type PageTypeDefinition,
  type PropertyDefinition,
  type SpaceSchema,
} from "@knowledge/shared/page";
import { parentPath } from "@knowledge/shared/paths";
import type { Db, DbOrTx } from "../db/client";
import { changeSetEvents, changeSetItems, changeSets, pages, spaces } from "../db/schema";
import type { Principal, UserPrincipal } from "../auth/principal";
import { audit } from "../core/audit";
import { visibleStatus } from "../pages/views";
import type { SpaceContext } from "../spaces/access";
import {
  KEY_MAPPING,
  convertVitepress,
  firstHeading,
  inferProperty,
  pathOfFile,
  pathOfSegments,
  stripCommonFolder,
  titleFromName,
} from "./convert";
import { readZip } from "./zip";

/** Uncompressed size of all files of an import at most. */
const MAX_UNCOMPRESSED_BYTES = MAX_IMPORT_BYTES * 4;
/** One Markdown file at most. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** `_space.yaml` at most: parsing YAML takes far more memory than its text. */
const MAX_SPACE_FILE_BYTES = 1024 * 1024;

/**
 * Exports a space as a zip: `<path>.md` for every live page (sub-pages in
 * folders named like their page) and `_space.yaml` with the space's
 * settings and page order. Drafts only for editors.
 */
export async function exportSpace(
  db: DbOrTx,
  principal: Principal,
  context: SpaceContext,
): Promise<Uint8Array> {
  const { space } = context;
  const rows = await db
    .select()
    .from(pages)
    .where(and(eq(pages.spaceId, space.id), isNull(pages.deletedAt), visibleStatus(principal)))
    .orderBy(asc(pages.path));
  const entries: Record<string, Uint8Array> = {};
  for (const row of rows) entries[`${row.path}.md`] = strToU8(row.markdown);
  const order = [...rows]
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
    .map((row) => row.path);
  entries["_space.yaml"] = strToU8(
    stringifyYaml(
      {
        name: space.name,
        description: space.description,
        properties: space.properties,
        pageTypes: space.pageTypes,
        order,
      },
      { lineWidth: 0 },
    ),
  );
  return zipSync(entries, { level: 6 });
}

type Candidate = { file: string; path: string; values: Record<string, unknown>; body: string };

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Imports a zip of Markdown files into one change set of the space, to
 * review and merge (docs/architecture.md, "Import and export"). Owners and
 * admins may let it add unknown frontmatter keys and page types to the
 * space (`defineProperties`); otherwise those are dropped and listed.
 */
export async function importSpace(
  db: Db,
  actor: UserPrincipal,
  context: SpaceContext,
  input: { data: Uint8Array; fileName: string; defineProperties: boolean; title?: string },
): Promise<ImportResult> {
  const { space } = context;
  const define = input.defineProperties && context.abilities.manage;
  const result: ImportResult = {
    changeSet: null,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: [],
    droppedProperties: [],
    definedProperties: [],
    definedPageTypes: [],
    notes: [],
  };
  // Files are inflated one at a time, when needed, and only up to their declared size.
  const zip = new Map(
    readZip(input.data, { maxFiles: MAX_IMPORT_FILES, maxBytes: MAX_UNCOMPRESSED_BYTES }).map((entry) => [
      entry.name,
      entry,
    ]),
  );
  const names = stripCommonFolder([...zip.keys()]);

  const candidates: Candidate[] = [];
  const taken = new Map<string, string>();
  let spaceFile: Record<string, unknown> | null = null;
  let callouts = 0;
  let anchors = 0;
  let renamed = 0;

  for (const [original, name] of names) {
    const entry = zip.get(original)!;
    if (name === "_space.yaml") {
      if (entry.size > MAX_SPACE_FILE_BYTES) {
        result.skipped.push({ file: name, reason: "The file is larger than 1 MB" });
        continue;
      }
      const data = entry.read();
      try {
        const parsed: unknown = parseYaml(decoder.decode(data));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          spaceFile = parsed as Record<string, unknown>;
      } catch {
        result.skipped.push({ file: name, reason: "Not valid YAML" });
      }
      continue;
    }
    if (name.split("/").some((segment) => segment.startsWith("_") || segment.startsWith("."))) {
      result.skipped.push({ file: name, reason: "Names starting with _ or . are skipped" });
      continue;
    }
    if (!/\.md$/i.test(name)) {
      result.skipped.push({ file: name, reason: "Not a Markdown file" });
      continue;
    }
    if (entry.size > MAX_FILE_BYTES) {
      result.skipped.push({ file: name, reason: "The file is larger than 2 MB" });
      continue;
    }
    const mapped = pathOfFile(name);
    if ("error" in mapped) {
      result.skipped.push({ file: name, reason: mapped.error });
      continue;
    }
    if (taken.has(mapped.path)) {
      result.skipped.push({
        file: name,
        reason: `Another file (${taken.get(mapped.path)}) has the same page path`,
      });
      continue;
    }
    // Other requests get their turn between files.
    await nextTurn();
    const data = entry.read();
    let text: string;
    try {
      text = decoder.decode(data);
    } catch {
      result.skipped.push({ file: name, reason: "The file is not UTF-8 text" });
      continue;
    }
    const parts = splitFrontmatter(text);
    const read = parts ? readFrontmatterValues(parts.yaml) : { values: {} };
    if ("error" in read) {
      result.skipped.push({ file: name, reason: read.error });
      continue;
    }
    const converted = convertVitepress(parts ? parts.body : text);
    callouts += converted.callouts;
    anchors += converted.anchors;
    if (mapped.renamed) renamed += 1;
    taken.set(mapped.path, name);
    candidates.push({ file: name, path: mapped.path, values: read.values, body: converted.body });
  }

  // Folders without a page of their own get one.
  for (const candidate of [...candidates]) {
    let parent = parentPath(candidate.path);
    while (parent && !taken.has(parent)) {
      const segment = parent.split("/").at(-1)!;
      const created = pathOfSegments(parent.split("/"));
      if (!("error" in created)) {
        taken.set(parent, `${parent}/`);
        candidates.push({
          file: `${parent}/`,
          path: parent,
          values: { title: titleFromName(segment) },
          body: "",
        });
      }
      parent = parentPath(parent);
    }
  }

  // Frontmatter of other tools; unknown keys and page types.
  const schema: SpaceSchema = { properties: [...space.properties], pageTypes: [...space.pageTypes] };
  if (define && spaceFile) mergeSpaceFile(schema, spaceFile, result);
  const known = new Set<string>([...BUILT_IN_KEYS, ...schema.properties.map((property) => property.key)]);
  const unknownValues = new Map<string, unknown[]>();
  const dropped = new Set<string>();
  for (const candidate of candidates) {
    const values: Record<string, unknown> = {};
    for (const [rawKey, value] of Object.entries(candidate.values)) {
      const key = rawKey in KEY_MAPPING ? KEY_MAPPING[rawKey] : rawKey;
      if (key === null || key === undefined) continue;
      values[key] = value;
      if (!known.has(key)) unknownValues.set(key, [...(unknownValues.get(key) ?? []), value]);
    }
    if (values.title === undefined || values.title === null || values.title === "") {
      values.title = firstHeading(candidate.body) ?? titleFromName(candidate.path.split("/").at(-1)!);
    }
    candidate.values = values;
  }
  for (const [key, values] of unknownValues) {
    const definition = define ? inferProperty(key, values) : null;
    if (definition) {
      schema.properties.push(definition);
      result.definedProperties.push(key);
    } else dropped.add(key);
  }
  for (const candidate of candidates) {
    for (const key of dropped) delete candidate.values[key];
    const type = candidate.values.type;
    if (typeof type === "string" && type && !schema.pageTypes.some((pageType) => pageType.key === type)) {
      if (define && PAGE_TYPE_KEY_PATTERN.test(type)) {
        schema.pageTypes.push({
          key: type,
          label: titleFromName(type),
          template: "",
          requiredProperties: [],
        });
        result.definedPageTypes.push(type);
      } else {
        delete candidate.values.type;
        dropped.add("type");
      }
    }
  }
  result.droppedProperties = [...dropped].sort();

  // Files in canonical form, against the (extended) schema.
  type Prepared = { candidate: Candidate; markdown: string; title: string };
  const prepared: Prepared[] = [];
  for (const candidate of candidates) {
    await nextTurn();
    const yaml = stringifyYaml(candidate.values, { lineWidth: 0 });
    const canonical = canonicalPageFile(`---\n${yaml}---\n\n${candidate.body}`, schema);
    if (!canonical.ok) {
      const reason = Object.values(canonical.errors)[0] ?? "The page is not valid";
      result.skipped.push({ file: candidate.file, reason });
      taken.delete(candidate.path);
      continue;
    }
    prepared.push({ candidate, markdown: canonical.markdown, title: canonical.page.frontmatter.title });
    // Only the canonical file is needed from here on.
    candidate.body = "";
  }
  prepared.sort((a, b) => a.candidate.path.split("/").length - b.candidate.path.split("/").length);

  if (callouts > 0) result.notes.push(`Turned ${callouts} VitePress boxes into callouts.`);
  if (anchors > 0) result.notes.push(`Removed ${anchors} custom heading anchors ({#…}).`);
  if (renamed > 0) result.notes.push(`Changed ${renamed} file names into valid page paths.`);

  return db.transaction(async (tx) => {
    const live = await tx
      .select()
      .from(pages)
      .where(and(eq(pages.spaceId, space.id), isNull(pages.deletedAt)));
    const byPath = new Map(live.map((page) => [page.path, page]));
    type Item = typeof changeSetItems.$inferInsert;
    const items: (Item & { title: string })[] = [];
    const available = new Set([...byPath.keys(), ...prepared.map((item) => item.candidate.path)]);
    for (const item of prepared) {
      const parent = parentPath(item.candidate.path);
      if (parent && !available.has(parent)) {
        // Its parent could not be imported (and is no live page).
        result.skipped.push({ file: item.candidate.file, reason: "Its parent page could not be imported" });
        available.delete(item.candidate.path);
        continue;
      }
      const existing = byPath.get(item.candidate.path);
      if (existing && existing.markdown === item.markdown) {
        result.unchanged += 1;
        continue;
      }
      if (existing) result.updated += 1;
      else result.created += 1;
      items.push({
        changeSetId: "",
        pageId: existing?.id ?? randomUUID(),
        action: existing ? "update" : "create",
        baseRevision: existing?.revision ?? null,
        path: item.candidate.path,
        markdown: item.markdown,
        updatedById: actor.id,
        title: item.title,
      });
    }

    if (result.definedProperties.length > 0 || result.definedPageTypes.length > 0) {
      // Adds to the settings as they are now: an owner may have changed them meanwhile.
      const [current] = await tx
        .select({ properties: spaces.properties, pageTypes: spaces.pageTypes })
        .from(spaces)
        .where(eq(spaces.id, space.id))
        .for("no key update");
      const properties = [...current!.properties];
      for (const property of schema.properties) {
        if (!result.definedProperties.includes(property.key)) continue;
        if (!properties.some((existing) => existing.key === property.key)) properties.push(property);
      }
      const pageTypes = [...current!.pageTypes];
      for (const pageType of schema.pageTypes) {
        if (!result.definedPageTypes.includes(pageType.key)) continue;
        if (!pageTypes.some((existing) => existing.key === pageType.key)) pageTypes.push(pageType);
      }
      await tx
        .update(spaces)
        .set({ properties, pageTypes, updatedAt: sql`now()` })
        .where(eq(spaces.id, space.id));
      await audit(tx, actor, {
        action: "space.updated",
        entityType: "space",
        entityId: space.id,
        summary: `An import added ${[...result.definedProperties, ...result.definedPageTypes].length} properties and page types to the space ${space.name}`,
      });
    }
    if (items.length === 0) return result;

    const title = input.title?.trim() || `Import ${input.fileName}`.slice(0, 200);
    const description = [
      `Imported from ${input.fileName}: ${result.created} new and ${result.updated} changed pages.`,
      ...result.notes,
      result.droppedProperties.length > 0
        ? `Removed properties: ${result.droppedProperties.join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const [changeSet] = await tx
      .insert(changeSets)
      .values({
        spaceId: space.id,
        title,
        description,
        status: "open",
        authorId: actor.id,
        channel: "web",
        clientName: null,
      })
      .returning();
    await tx
      .insert(changeSetEvents)
      .values({ changeSetId: changeSet!.id, kind: "created", actorId: actor.id });
    for (const item of items) {
      const { title: pageTitle, ...row } = item;
      await tx.insert(changeSetItems).values({ ...row, changeSetId: changeSet!.id });
      await tx.insert(changeSetEvents).values({
        changeSetId: changeSet!.id,
        kind: "edited",
        actorId: actor.id,
        body: item.action === "create" ? "Imported a new page" : "Imported changes",
        pageId: item.pageId,
        pagePath: item.path,
        pageTitle,
      });
    }
    result.changeSet = { number: changeSet!.number };
    return result;
  });
}

/** Adds properties and page types from an exported `_space.yaml` that the space lacks. */
function mergeSpaceFile(schema: SpaceSchema, file: Record<string, unknown>, result: ImportResult) {
  const properties = Array.isArray(file.properties) ? file.properties : [];
  for (const raw of properties) {
    const parsed = propertyDefinitionSchema.safeParse(raw);
    if (!parsed.success) continue;
    const definition: PropertyDefinition = parsed.data;
    if (schema.properties.some((property) => property.key === definition.key)) continue;
    schema.properties.push(definition);
    result.definedProperties.push(definition.key);
  }
  const pageTypes = Array.isArray(file.pageTypes) ? file.pageTypes : [];
  for (const raw of pageTypes) {
    const parsed = pageTypeDefinitionSchema.safeParse(raw);
    if (!parsed.success) continue;
    const definition: PageTypeDefinition = parsed.data;
    if (schema.pageTypes.some((pageType) => pageType.key === definition.key)) continue;
    const keys = new Set(schema.properties.map((property) => property.key));
    schema.pageTypes.push({
      ...definition,
      requiredProperties: definition.requiredProperties.filter((key) => keys.has(key)),
    });
    result.definedPageTypes.push(definition.key);
  }
}

/** For tests: a zip from a map of names to text. */
export function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

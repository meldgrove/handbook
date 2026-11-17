import { Hono } from "hono";
import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import {
  importOptionsSchema,
  spaceCreateSchema,
  spaceListQuerySchema,
  spaceMemberPutSchema,
  spaceUpdateSchema,
} from "@knowledge/shared/api/spaces";
import { MAX_IMPORT_BYTES } from "@knowledge/shared/limits";
import { getDb } from "../db/client";
import { pages, users } from "../db/schema";
import type { AppEnv } from "../http/env";
import { badRequest, forbidden } from "../http/errors";
import { idParam, jsonBody, queryOf, requireAdmin, requirePrincipal, requireUser } from "../http/middleware";
import { getSpace, requireAbility, spaceContext } from "../spaces/access";
import {
  createSpace,
  listMembers,
  listSpaces,
  putMember,
  removeMember,
  setArchived,
  spaceView,
  updateSpace,
} from "../spaces/service";
import { actorOf, iso, pageSummary } from "../pages/views";
import { multipartBody } from "./util";
import { exportSpace, importSpace } from "../imports/import";

const router = new Hono<AppEnv>();

router.get("/spaces", async (c) => {
  const principal = requirePrincipal(c);
  const query = queryOf(c, spaceListQuerySchema);
  return c.json({ items: await listSpaces(getDb(), principal, query.archived) });
});

router.post("/spaces", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, spaceCreateSchema);
  const space = await createSpace(getDb(), actor, input);
  return c.json(await spaceView(getDb(), actor, await spaceContext(getDb(), actor, space)), 201);
});

router.get("/spaces/:space", async (c) => {
  const principal = requirePrincipal(c);
  const context = await spaceContext(getDb(), principal, c.req.param("space"));
  return c.json(await spaceView(getDb(), principal, context));
});

router.patch("/spaces/:space", async (c) => {
  const actor = requireUser(c);
  const context = await spaceContext(getDb(), actor, c.req.param("space"));
  const input = await jsonBody(c, spaceUpdateSchema);
  const space = await updateSpace(getDb(), actor, context, input);
  return c.json(await spaceView(getDb(), actor, await spaceContext(getDb(), actor, space)));
});

for (const [action, archived] of [
  ["archive", true],
  ["unarchive", false],
] as const) {
  router.post(`/spaces/:space/${action}`, async (c) => {
    const actor = requireAdmin(c);
    const space = await setArchived(getDb(), actor, await getSpace(getDb(), c.req.param("space")), archived);
    return c.json(await spaceView(getDb(), actor, await spaceContext(getDb(), actor, space)));
  });
}

router.get("/spaces/:space/members", async (c) => {
  requireUser(c);
  const space = await getSpace(getDb(), c.req.param("space"));
  return c.json({ items: await listMembers(getDb(), space.id) });
});

router.put("/spaces/:space/members", async (c) => {
  const actor = requireUser(c);
  const context = await spaceContext(getDb(), actor, c.req.param("space"));
  await putMember(getDb(), actor, context, await jsonBody(c, spaceMemberPutSchema));
  return c.json({ items: await listMembers(getDb(), context.space.id) });
});

router.delete("/spaces/:space/members/:userId", async (c) => {
  const actor = requireUser(c);
  const context = await spaceContext(getDb(), actor, c.req.param("space"));
  await removeMember(getDb(), actor, context, idParam(c, "userId"));
  return c.json({ items: await listMembers(getDb(), context.space.id) });
});

router.get("/spaces/:space/tree", async (c) => {
  const principal = requirePrincipal(c);
  const { space, abilities } = await spaceContext(getDb(), principal, c.req.param("space"));
  const rows = await getDb()
    .select()
    .from(pages)
    .where(
      and(
        eq(pages.spaceId, space.id),
        isNull(pages.deletedAt),
        abilities.seeDrafts ? sql`true` : ne(pages.status, "draft"),
      ),
    )
    .orderBy(asc(pages.position), asc(pages.title));
  return c.json({ items: rows.map((row) => pageSummary(row, space.slug)) });
});

router.get("/spaces/:space/trash", async (c) => {
  const principal = requirePrincipal(c);
  const context = await spaceContext(getDb(), principal, c.req.param("space"));
  if (!context.abilities.seeDrafts) throw forbidden("Only editors of this space see its trash");
  const rows = await getDb()
    .select({ page: pages, deletedBy: { id: users.id, name: users.name, email: users.email } })
    .from(pages)
    .leftJoin(users, eq(users.id, pages.deletedById))
    .where(and(eq(pages.spaceId, context.space.id), isNotNull(pages.deletedAt)))
    .orderBy(desc(pages.deletedAt));
  return c.json({
    items: rows.map((row) => ({
      ...pageSummary(row.page, context.space.slug),
      deletedAt: iso(row.page.deletedAt!),
      deletedBy: actorOf(row.deletedBy),
    })),
  });
});

router.get("/spaces/:space/export", async (c) => {
  const principal = requirePrincipal(c);
  const context = await spaceContext(getDb(), principal, c.req.param("space"));
  const zip = await exportSpace(getDb(), principal, context);
  c.header("content-type", "application/zip");
  c.header("content-disposition", `attachment; filename="${context.space.slug}.zip"`);
  c.header("cache-control", "private, no-store");
  return c.body(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer);
});

router.post("/spaces/:space/import", async (c) => {
  const actor = requireUser(c);
  const context = await spaceContext(getDb(), actor, c.req.param("space"));
  requireAbility(context, "editLive");
  const body = await multipartBody(c);
  const file = body.file;
  if (!(file instanceof File)) throw badRequest("Choose a zip file");
  if (file.size > MAX_IMPORT_BYTES) throw badRequest("The zip file is too large");
  const options = importOptionsSchema.parse({
    defineProperties: typeof body.defineProperties === "string" ? body.defineProperties : undefined,
    title: typeof body.title === "string" ? body.title : undefined,
  });
  const result = await importSpace(getDb(), actor, context, {
    data: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name || "upload.zip",
    defineProperties: options.defineProperties,
    title: options.title,
  });
  return c.json(result, 201);
});

export default router;

# User guide

How to read, write and review pages.

## Spaces and pages

A **space** is one knowledge base, usually of a team or a topic. The sidebar
lists them. Everyone signed in reads every space; its **owners** and
**editors** change it (listed in the space's settings).

A **page** is one Markdown file with properties. Pages form a tree: a page
can have sub-pages, and its address follows the tree:
`/s/<space>/onboarding/laptop`. Old addresses keep working after a page
moves.

## Reading

- **Search** in the top bar finds words in titles, search terms, tags and
  text, also in other word forms (e.g. "laptops" finds "laptop") and with
  small typos in titles. Results jump to the matching section.
- **Tags** group pages across spaces.
- A page shows its properties on the side, the pages that link to it
  ("Linked from"), and its sub-pages.
- The page menu has **History** (every version, who changed it and how) and
  **View Markdown file**.

## Writing

Editors use **Edit** on a page, or **New page** in a space.

- The editor has three views: **Write** (the text, with a preview beside it
  on wide screens), **Preview**, and **Whole file** (frontmatter and text
  together). **Properties** above the text edits the frontmatter as a form.
- Markdown with GitHub's additions: headings, lists, task lists, tables,
  links, code, and callouts:

  ```markdown
  > [!WARNING]
  > Back up the laptop before you send it in.
  ```

  The callout kinds are `NOTE`, `TIP`, `IMPORTANT`, `WARNING` and `CAUTION`.
  HTML is shown as text, never run.

- **Limits:** a page has at most 500,000 characters. Saving refuses Markdown
  that would take too long to show, and names the line: lists, quotes and
  footnotes nested more than 16 levels deep, a paragraph (lines without a
  blank line between them) of more than 20,000 characters or with more than
  1,000 `*`, `_` and `~`, and very long pages full of lists, quotes or
  tables. Split those up with blank lines or into several pages.

- **Links to other pages** are ordinary Markdown links: `[VPN](vpn)` links
  to a page next to this one, `[AI policy](../policies/ai)` one level up,
  `[Leave](/s/hr/leave)` to another space. The toolbar's link button finds
  pages for you.
- **Images:** paste or drop them into the text, or use the image button.
- **Page types** (set up by owners) start a new page from a template and can
  require properties.
- **Status:** `draft` pages are only visible to the space's editors;
  `deprecated` pages show a notice, with "Replaced by" pointing to the newer
  page.

### When someone else edits the same page

Only one person edits a page at a time. When someone else has the page open
in the editor, you see who and since when, and can read the page, suggest
your change instead, or (editors) **Take over**. The other person then sees
that you took over; their text stays saved as a draft.

After a pause (30 minutes without typing, or a computer that went to sleep)
others may open the page in the editor. The editor says so; when you type
again it continues, unless someone else started editing meanwhile.

The editor saves your unsaved text as a draft every few seconds and offers
it when you come back (also after the page was deleted and restored). If
the page changed while you edited it (for example after a takeover or a
merged change set), saving combines both changes, also two changes to
different words of one paragraph; if both changed the same words, the
editor shows both versions of those lines marked:

```
<<<<<<< yours
your lines
=======
the current lines
>>>>>>> current
```

Keep what is right, remove the marks, and save again.

## Suggesting changes: change sets

A **change set** collects changes to pages of one space: new pages, edits,
moves and deletions. Nobody sees them on the pages until an editor merges
them. Readers use **Suggest an edit** on a page (or **Suggest a new page**
in a space); editors can use change sets for larger work too; AI agents
always use them.

1. **Suggest an edit** opens the editor. Saving asks for a title and why,
   and **Send for review** asks the space's editors to look at it: they
   find it on their start page under "Waiting for your review". The change
   set opens; add more pages with **Add a page** or **Edit** on its pages.
2. A change set that is open but not in review (one an agent or an editor
   started, or one an editor asked to change) goes to the editors with
   **Submit for review**.
3. Editors see each page's changes as a diff, with the changed words marked
   (or a preview), the
   **checks** (errors block merging, e.g. a missing parent page; warnings,
   e.g. a link to a page that would not exist), and the activity. They
   comment, **Request changes**, or **Merge**.
4. **Merge** publishes every page of the change set at once. If a page
   changed live in the meantime, both changes are combined; if they overlap,
   **Update from live** on that page brings the current version in with the
   overlapping lines marked, to resolve before merging.
5. **Revert** on a merged change set undoes all its pages at once, as a new
   change set that is merged right away (or left open when later changes
   overlap; **Revert** again then opens that one).

**Close** shelves a change set; **Reopen** brings it back. Nothing is ever
lost: every version stays in the history, deleted pages go to the space's
trash, closed change sets stay readable.

## Agents

Under **Settings → Connect an agent** you find the address for AI agents
(Claude, ChatGPT, Langdock, Claude Code and others). An agent acts as you:
it reads everything and proposes changes as change sets for editors to
review; it never publishes or merges. See [Agents and MCP](agents.md).

## Owners: setting up a space

In the space's **Settings**:

- **Owners and editors**: add people by email (also before their first
  sign-in). Only admins add owners.
- **Properties**: custom fields of the space's pages, with a type (text,
  list, number, yes/no, date, one choice, several choices, URL, person),
  optionally required. Pages may only use defined properties; a change that
  would make existing pages invalid is refused with the pages named.
- **Page types**: a label, a key, a template for new pages and required
  properties.

The space menu also has **Export**: a zip of the space's Markdown files
(sub-pages in folders) and the images and attachments they use, in
`files/<id>/<name>` where the pages' links (`/files/<id>/<name>`) find
them.

To bring existing content in, let an agent write it: it reads your
documents and creates the pages in a change set, which an editor reviews
and merges ([Agents and MCP](agents.md)).

Built-in properties every page may have: `title` (required), `description`,
`type`, `status`, `tags`, `owner` (an email address), `reviewed` (a date),
`replaced_by` (a page path) and `search_terms` (other words people search
for, e.g. in another language).

## Admins: updates

Admins see an update icon in the header. A dot on it means a new version is
available: click it for the changes and **Install now**. Handbook restarts
for a moment, and the page reloads when the new version runs. A warning
triangle means an installation failed; the icon says why, and the version
before keeps running. **Administration → Updates** shows the installed
version and the channel: **Stable** (releases, recommended) or **Preview**
(every change before it is released). The server must run the updater
([Deployment](deployment.md#automatic-updates)).

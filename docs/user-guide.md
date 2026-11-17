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

The editor saves your unsaved text as a draft every few seconds and offers
it when you come back (also after the page was deleted and restored). If
the page changed while you edited it (for example after a takeover or a
merged change set), saving combines both changes; if both changed the same
lines, the editor shows them marked:

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

1. **Suggest an edit** opens the editor. Saving asks for a title and why;
   the change set opens. Add more pages with **Add a page** or **Edit** on
   its pages.
2. **Submit for review** asks the space's editors to look at it.
3. Editors see each page's changes as a diff (or a preview), the
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

The space menu also has **Export** (a zip of Markdown files) and **Import**
(a zip of Markdown files becomes a change set to review; frontmatter keys
the space does not define are dropped and listed, or added to the space
when you choose so; VitePress boxes such as `::: warning` become callouts).

Built-in properties every page may have: `title` (required), `description`,
`type`, `status`, `tags`, `owner` (an email address), `reviewed` (a date),
`replaced_by` (a page path) and `search_terms` (other words people search
for, e.g. in another language).

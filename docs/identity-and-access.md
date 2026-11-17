# Identity and access

People sign in through one OpenID Connect provider. Everyone who may sign in
reads every space. Admins, space owners and space editors are set in the
app.

## Roles

| Who                            | May                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Everyone signed in             | Read and export every space (drafts only in spaces they edit); search, suggest changes as change sets, comment and connect agents. |
| Space editor                   | Also: create, edit, move and delete pages live; import; review, merge, close and revert change sets; restore pages and versions.   |
| Space owner                    | Also: the space's name and description, its editors, properties and page types (also through an import).                           |
| Admin                          | Everything in every space; create and archive spaces; choose owners; people; service tokens; the audit log.                        |
| Agent (token or connected app) | Acts as its person, but only reads and proposes: it writes only into change sets and never merges or administers.                  |
| Service token                  | Reads only (search, pages, Markdown files): for integrations such as a support bot.                                                |

Archived spaces are read-only for everyone: no page changes, change sets,
comments or status changes until an admin restores the space.

Owners and editors are chosen in the space's **Settings**; owners can add
editors, only admins add owners. A person can be named by email before
their first sign-in and gets the role then.

Admins come from `ADMIN_EMAILS` (always admins, also the way back in) or are
made admins by another admin under **Administration → People**. There,
admins can also block someone: blocked people cannot sign in, and their
sessions and tokens stop working.

Admins can also remove a person (**Remove** under **Administration →
People**), for example when someone leaves and asks for their data to be
deleted. Their name and email are replaced, and their sign-ins, tokens,
connected apps, unsaved drafts, edit locks and space roles are deleted.
Their page versions, change sets and comments stay, shown as "Removed
person", and the audit log keeps their actions without their email. Page
texts that name them (e.g. an `owner` property) are not changed; edit those
pages. If they sign in again, they start as a new person without roles.
People in `ADMIN_EMAILS` cannot be removed (take them out of the list
first), and nobody removes themselves.

## Sign-in

Register a client at the provider (confidential, authorization code flow)
with this redirect URL:

```
<APP_URL>/api/auth/callback/oidc
```

and set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`. The
provider must return the email address (scopes `openid email profile`); the
app trusts it, so use your organization's own provider, where people cannot
choose their address.

Examples of `OIDC_ISSUER`:

| Provider           | Issuer                                               |
| ------------------ | ---------------------------------------------------- |
| Keycloak           | `https://login.example.org/realms/<realm>`           |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Google             | `https://accounts.google.com`                        |
| Authentik          | `https://auth.example.org/application/o/<slug>/`     |

## Who may sign in

By default everyone the provider lets through may sign in and read. Two
optional limits, checked at every sign-in:

- `ALLOWED_EMAIL_DOMAINS=example.org,example.net`: only these domains.
- `ACCESS_GROUPS=/staff`: only members of one of these groups. The groups
  come from the claim `OIDC_GROUPS_CLAIM` (default `groups`) of the ID
  token, or of the userinfo endpoint when the ID token has none. Keycloak
  group paths count their subgroups: `/staff` admits `/staff/it`.

People refused at sign-in see "This account has no access"; the log says
why. Admins in `ADMIN_EMAILS` are never refused.

### Keycloak

1. Create a client (`Client authentication` on, standard flow) with the
   redirect URL above and the web origin `APP_URL`.
2. For `ACCESS_GROUPS`: add a mapper "Group Membership" to the client's
   dedicated scope with claim name `groups`, "Full group path" on, and
   "Add to ID token" on. Then set `ACCESS_GROUPS` to group paths, e.g.
   `/staff`.

### Microsoft Entra ID

Register an app with the redirect URL above (platform Web) and a client
secret. For `ACCESS_GROUPS`, add the groups claim in **Token configuration**
(the claim then holds group object IDs; use those in `ACCESS_GROUPS`).

## Agents

Agents act as a person through a connected app (OAuth) or a personal token,
with the limits above. See [Agents and MCP](agents.md).

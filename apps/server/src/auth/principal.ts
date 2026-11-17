import type { Channel } from "@knowledge/shared/roles";

/** A person, signed in through the web app or acting through an agent's credential. */
export type UserPrincipal = {
  kind: "user";
  id: string;
  email: string;
  name: string;
  image: string | null;
  isAdmin: boolean;
  /** web (session cookie), token (personal access token) or oauth (connected app). */
  channel: Exclude<Channel, "service">;
  /**
   * True for agents (personal tokens and connected apps): they read
   * everything and write only into change sets.
   */
  agent: boolean;
  /** The token's name or the connected app's name, e.g. "Claude". */
  clientName: string | null;
  /** The credential used, for last-use times and audit. */
  credentialId: string | null;
};

/** A read-only service token (integrations such as a support bot). */
export type ServicePrincipal = {
  kind: "service";
  credentialId: string;
  name: string;
};

export type Principal = UserPrincipal | ServicePrincipal;

/** A short name for histories: "Ada Lovelace" or "Ada Lovelace via Claude". */
export function principalLabel(principal: Principal): string {
  if (principal.kind === "service") return principal.name;
  const name = principal.name || principal.email;
  return principal.clientName ? `${name} via ${principal.clientName}` : name;
}

/**
 * Vault references: the only form in which a Vault secret enters a Computer.
 *
 * When a Computer opens an Agent command's native invocation, it asks the
 * owner which secrets that Agent holds and puts one `fvr1.` reference per
 * secret into that command's environment, under the secret's name. A
 * reference is not the credential. It names the owner, the secret, the Agent
 * and this command's invocation, and only this Computer's egress gateway resolves it,
 * only while that invocation is live. The gateway then asks the owner to place
 * the real value on a request to one of the secret's bound destinations. Only
 * a reference's digest is stored, so a copy on another Computer, or after its
 * command ended, names nothing.
 *
 * Apps hold no Vault power: the only subject a reference can name is an Agent.
 */
import type {
  ComputerExecutionHostHooks,
  ComputerValue,
} from "@fungi.computer/computer-contract";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { z } from "zod";
import { reportCatchFailure } from "./failure.js";

const referencePrefix = "fvr1.";
/** 32 random bytes, base64url without padding. */
const referenceGrammar = /fvr1\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu;
/** A POSIX-portable environment name; other secret names get no reference. */
const environmentName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/** Every distinct reference written anywhere in `text`. */
export function vaultReferencesIn(text: string): readonly string[] {
  return [...new Set(text.match(referenceGrammar) ?? [])];
}

const subjectSchema = z.strictObject({
  kind: z.literal("agent"),
  // Veil's Connection identifier grammar.
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/u),
});
export type VaultSubject = z.output<typeof subjectSchema>;

const vaultHolderSchema = z.strictObject({
  /** The host's name for the secrets' owner: Hub's Team, Oyster's directory. */
  owner: z.string().min(1).max(256),
  subject: subjectSchema,
});
/** Whose secrets one Agent command may name. */
export type VaultHolder = z.output<typeof vaultHolderSchema>;
const vaultExecutionContextSchema = z.strictObject({
  vault: vaultHolderSchema,
});

/** The durable, secret-free context of one Agent command that may hold references. */
export function vaultExecutionContext(holder: VaultHolder): ComputerValue {
  return vaultExecutionContextSchema.parse({ vault: holder });
}

export function isVaultExecutionContext(context: ComputerValue): boolean {
  return vaultExecutionContextSchema.safeParse(context).success;
}

/** One secret a subject holds, as its owner lists it: never the value. */
export type VaultSecretGrant = Readonly<{
  name: string;
  connectionId: string;
  grantVersion: number;
}>;

/** The owner's live answer: which secrets this subject holds now. */
export type VaultGrantPort = Readonly<{
  grants(holder: VaultHolder): Promise<readonly VaultSecretGrant[]>;
}>;

/** What a presented reference names, once the gateway resolves it. */
export type VaultReferenceAdmission = Readonly<{
  invocationId: string;
  owner: string;
  subject: VaultSubject;
  connectionId: string;
  grantVersion: number;
}>;

const referenceRowSchema = z.object({
  invocation_id: z.string(),
  owner: z.string(),
  subject_kind: z.literal("agent"),
  subject_id: z.string(),
  connection_id: z.string(),
  grant_version: z.number().int().positive(),
});

function mintReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return `${referencePrefix}${base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

async function referenceDigest(reference: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(reference),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** This Computer's reference rows, in its own SQLite storage. */
export function createComputerVaultReferences(sql: WatchdogSqliteOwner["sql"]) {
  sql.exec(`CREATE TABLE IF NOT EXISTS computer_vault_references (
    reference_digest TEXT PRIMARY KEY,
    invocation_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK(subject_kind='agent'),
    subject_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    grant_version INTEGER NOT NULL
  ) STRICT`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS computer_vault_references_invocation ON computer_vault_references(invocation_id)",
  );
  return {
    /**
     * One reference per granted secret, named by the secret. Names are taken
     * in connection order; a repeated or non-portable name gets none.
     */
    async issue(
      invocationId: string,
      { owner, subject }: VaultHolder,
      grants: readonly VaultSecretGrant[],
    ): Promise<Readonly<Record<string, string>>> {
      const environment: Record<string, string> = {};
      const ordered = [...grants].sort((left, right) =>
        left.connectionId.localeCompare(right.connectionId),
      );
      for (const grant of ordered) {
        if (
          !environmentName.test(grant.name) ||
          Object.hasOwn(environment, grant.name)
        )
          continue;
        const reference = mintReference();
        sql.exec(
          "INSERT INTO computer_vault_references VALUES(?,?,?,?,?,?,?)",
          await referenceDigest(reference),
          invocationId,
          owner,
          subject.kind,
          subject.id,
          grant.connectionId,
          grant.grantVersion,
        );
        environment[grant.name] = reference;
      }
      return environment;
    },
    async find(reference: string): Promise<VaultReferenceAdmission | null> {
      if (vaultReferencesIn(reference)[0] !== reference) return null;
      const raw = sql
        .exec(
          "SELECT * FROM computer_vault_references WHERE reference_digest=?",
          await referenceDigest(reference),
        )
        .toArray()[0];
      if (raw === undefined) return null;
      const row = referenceRowSchema.parse(raw);
      return {
        invocationId: row.invocation_id,
        owner: row.owner,
        subject: { kind: row.subject_kind, id: row.subject_id },
        connectionId: row.connection_id,
        grantVersion: row.grant_version,
      };
    },
    close(invocationId: string): void {
      sql.exec(
        "DELETE FROM computer_vault_references WHERE invocation_id=?",
        invocationId,
      );
    },
  };
}
export type ComputerVaultReferences = ReturnType<
  typeof createComputerVaultReferences
>;

/**
 * The host hooks for an Agent command's references. An owner that cannot
 * answer gives the command no references; the command still runs, and it
 * never holds a value either way.
 */
export function vaultExecutionHooks(
  references: ComputerVaultReferences,
  port: VaultGrantPort,
): ComputerExecutionHostHooks {
  return {
    async open(invocation, context) {
      const holder = vaultExecutionContextSchema.parse(context).vault;
      let grants: readonly VaultSecretGrant[];
      try {
        grants = await port.grants(holder);
      } catch (cause) {
        // Still no references, but the failure is reported, never silent.
        reportCatchFailure("computer.vault-grants", cause);
        grants = [];
      }
      return { env: await references.issue(invocation.id, holder, grants) };
    },
    renew: () => Promise.resolve(),
    close(invocation) {
      references.close(invocation.id);
      return Promise.resolve();
    },
  };
}

/** A host's own credential hooks, with an Agent command's references beside them. */
export function withVaultExecution(
  vault: ComputerExecutionHostHooks,
  host: ComputerExecutionHostHooks,
): ComputerExecutionHostHooks {
  const pick = (context: ComputerValue) =>
    isVaultExecutionContext(context) ? vault : host;
  return {
    open: (invocation, context) => pick(context).open(invocation, context),
    renew: (invocation, context) => pick(context).renew(invocation, context),
    close: (invocation, context, reason) =>
      pick(context).close(invocation, context, reason),
  };
}

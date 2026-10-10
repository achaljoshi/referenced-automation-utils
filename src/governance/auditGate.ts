import * as fs from 'node:fs';

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';
const ORDER: Severity[] = ['info', 'low', 'moderate', 'high', 'critical'];

export interface Advisory {
  /** GHSA id where the advisory has one, else the registry's numeric source id. */
  id: string;
  pkg: string;
  severity: Severity;
  title: string;
  url: string;
  range?: string;
}

/** An accepted risk: written down, owned, justified and time-limited - never a silent exception. */
export interface AllowEntry {
  id: string;
  /** Narrow the exception to one package (an advisory can hit several). */
  package?: string;
  reason: string;
  owner?: string;
  /** YYYY-MM-DD. After this date the exception stops applying and the gate fails again, so it must be re-decided. */
  expires: string;
}

export interface Allowlist {
  allow: AllowEntry[];
}

/** The `npm audit --json` output is not the shape this gate understands. The gate must then FAIL (never read it as "no findings"). */
export class AuditShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditShapeError';
  }
}

/** The allowlist breaks the rules for exceptions (no owner, no package, too far in the future, ...). */
export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowlistError';
  }
}

export interface GateResult {
  /** At or above the threshold, not covered by a valid exception: fails the gate. */
  blocking: Advisory[];
  /** At or above the threshold, covered by a valid (unexpired) exception. */
  allowed: Array<{ advisory: Advisory; entry: AllowEntry; daysLeft: number }>;
  /** Exceptions whose date has passed - they no longer protect anything. */
  expired: Array<{ advisory: Advisory; entry: AllowEntry }>;
  /** Exceptions that match nothing in the current audit: the problem is gone, so delete the entry. */
  unused: AllowEntry[];
  belowThreshold: number;
}

function severityOf(value: unknown): Severity {
  return ORDER.includes(value as Severity) ? (value as Severity) : 'low';
}

/**
 * The advisories in `npm audit --json` output (report version 2), one per advisory and package. Throws
 * `AuditShapeError` for anything else: a different report version, a missing or mismatched `metadata.vulnerabilities.total`,
 * or vulnerable packages with no readable advisory - each would otherwise parse to "zero findings" and let the build pass.
 */
export function parseAudit(audit: unknown): Advisory[] {
  const report = audit as {
    auditReportVersion?: unknown;
    vulnerabilities?: unknown;
    metadata?: { vulnerabilities?: { total?: unknown } };
  } | null;
  if (report === null || typeof report !== 'object')
    throw new AuditShapeError('the npm audit output is not a JSON object');
  if (report.auditReportVersion !== 2)
    throw new AuditShapeError(
      `unsupported npm audit report version ${JSON.stringify(report.auditReportVersion)} (this gate reads version 2; npm 7 or newer)`,
    );
  const entries = report.vulnerabilities;
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries))
    throw new AuditShapeError('the npm audit report has no "vulnerabilities" object');
  const vulnerabilities = entries as Record<string, { via?: unknown[] }>;
  const total = report.metadata?.vulnerabilities?.total;
  if (typeof total !== 'number')
    throw new AuditShapeError('the npm audit report has no "metadata.vulnerabilities.total" to check it against');
  const listed = Object.keys(vulnerabilities).length;
  if (total !== listed)
    throw new AuditShapeError(
      `the npm audit report says ${total} vulnerable package(s) but lists ${listed} - it is incomplete or malformed`,
    );
  const seen = new Map<string, Advisory>();
  for (const [pkg, vulnerability] of Object.entries(vulnerabilities)) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via === 'string') continue; // a package affected only through another: the root cause is listed on its own
      const v = via as {
        source?: number;
        name?: string;
        title?: string;
        url?: string;
        severity?: string;
        range?: string;
      };
      const id = /GHSA-[a-z0-9-]+/i.exec(v.url ?? '')?.[0] ?? String(v.source ?? 'unknown');
      const advisory: Advisory = {
        id,
        pkg: v.name ?? pkg,
        severity: severityOf(v.severity),
        title: v.title ?? '',
        url: v.url ?? '',
        range: v.range,
      };
      seen.set(`${advisory.id}|${advisory.pkg}`, advisory);
    }
  }
  if (listed > 0 && seen.size === 0)
    throw new AuditShapeError(
      `the npm audit report lists ${listed} vulnerable package(s) but no advisory could be read from it`,
    );
  return [...seen.values()].sort(
    (a, b) => ORDER.indexOf(b.severity) - ORDER.indexOf(a.severity) || a.pkg.localeCompare(b.pkg),
  );
}

const DAY_MS = 86_400_000;

export function evaluate(
  advisories: Advisory[],
  allowlist: Allowlist,
  options: { threshold?: Severity; now?: Date } = {},
): GateResult {
  const threshold = options.threshold ?? 'high';
  const now = options.now ?? new Date();
  const result: GateResult = {
    blocking: [],
    allowed: [],
    expired: [],
    unused: [],
    belowThreshold: 0,
  };
  const used = new Set<AllowEntry>();

  for (const advisory of advisories) {
    const entry = allowlist.allow.find(
      (e) =>
        e.id.toLowerCase() === advisory.id.toLowerCase() &&
        (e.package === undefined || e.package === advisory.pkg),
    );
    if (entry) used.add(entry);
    if (ORDER.indexOf(advisory.severity) < ORDER.indexOf(threshold)) {
      result.belowThreshold++;
      continue;
    }
    if (!entry) {
      result.blocking.push(advisory);
      continue;
    }
    const expires = Date.parse(`${entry.expires}T23:59:59Z`);
    if (Number.isNaN(expires))
      throw new Error(
        `allowlist entry for ${entry.id} has an invalid "expires" (${entry.expires}); use YYYY-MM-DD`,
      );
    if (expires < now.getTime()) {
      result.expired.push({ advisory, entry });
      result.blocking.push(advisory);
    } else {
      result.allowed.push({
        advisory,
        entry,
        daysLeft: Math.ceil((expires - now.getTime()) / DAY_MS),
      });
    }
  }
  result.unused = allowlist.allow.filter((e) => !used.has(e));
  return result;
}

const NO_OWNER = /^(?:unassigned|unknown|none|n\/a|na|tbd|todo|nobody|-+)\b/i;

export interface AllowlistRules {
  /** Accept an entry whose owner is missing or a placeholder (UNASSIGNED, TBD). Default false: an exception nobody owns is nobody's to renew or retire. */
  allowUnassigned?: boolean;
  /** The furthest an expiry may be from today. Default 366 days: an accepted risk has to be re-decided at least yearly. */
  maxExpiryDays?: number;
  now?: Date;
}

/** Checks every entry against the rules for exceptions; throws `AllowlistError` naming the first offender. */
export function validateAllowlist(allowlist: Allowlist, rules: AllowlistRules = {}): void {
  const now = rules.now ?? new Date();
  const maxDays = rules.maxExpiryDays ?? 366;
  for (const entry of allowlist.allow) {
    const label = entry.id ? `${entry.id}${entry.package ? ` (${entry.package})` : ''}` : JSON.stringify(entry);
    if (!entry.id || !entry.package || !entry.reason || !entry.expires)
      throw new AllowlistError(
        `every allowlist entry needs "id", "package", "reason" and "expires" - an entry without a package would excuse the advisory in every package (found ${JSON.stringify(entry)})`,
      );
    const expires = Date.parse(`${entry.expires}T23:59:59Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) || Number.isNaN(expires))
      throw new AllowlistError(`allowlist entry ${label} has an invalid "expires" (${entry.expires}); use YYYY-MM-DD`);
    if (!rules.allowUnassigned && (!entry.owner || !entry.owner.trim() || NO_OWNER.test(entry.owner.trim())))
      throw new AllowlistError(
        `allowlist entry ${label} has no real owner (${JSON.stringify(entry.owner ?? '')}): name the person or team who will renew or retire it (--allow-unassigned to accept this for now)`,
      );
    const days = (expires - now.getTime()) / DAY_MS;
    if (days > maxDays)
      throw new AllowlistError(
        `allowlist entry ${label} expires on ${entry.expires}, ${Math.floor(days)} days away - more than the ${maxDays}-day limit; accepted risks must be re-decided regularly (--max-expiry-days to change the limit)`,
      );
  }
}

/** Entries whose expiry date has passed: they no longer excuse anything and should be fixed, renewed on purpose, or deleted. */
export function expiredEntries(allowlist: Allowlist, now: Date = new Date()): AllowEntry[] {
  return allowlist.allow.filter((e) => Date.parse(`${e.expires}T23:59:59Z`) < now.getTime());
}

export function loadAllowlist(file: string, rules: AllowlistRules = {}): Allowlist {
  if (!fs.existsSync(file)) return { allow: [] };
  let parsed: Allowlist;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Allowlist;
  } catch (error) {
    throw new AllowlistError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const allowlist = { allow: parsed.allow ?? [] };
  if (!Array.isArray(allowlist.allow)) throw new AllowlistError(`${file}: "allow" must be an array`);
  validateAllowlist(allowlist, rules);
  return allowlist;
}

export function formatGate(result: GateResult, threshold: Severity): string {
  const lines: string[] = [];
  for (const a of result.blocking) {
    const expired = result.expired.find((e) => e.advisory === a);
    lines.push(
      `BLOCKING  ${a.severity.toUpperCase()}  ${a.pkg}  ${a.id}  ${a.title}${a.range ? `  (${a.range})` : ''}\n          ${a.url}${expired ? `\n          the exception for it EXPIRED on ${expired.entry.expires} (${expired.entry.reason}) - fix it or re-decide it` : ''}`,
    );
  }
  for (const { advisory: a, entry, daysLeft } of result.allowed) {
    lines.push(
      `accepted  ${a.severity}  ${a.pkg}  ${a.id}  until ${entry.expires} (${daysLeft} day${daysLeft === 1 ? '' : 's'})${entry.owner ? `  owner ${entry.owner}` : ''}\n          ${entry.reason}`,
    );
    if (!entry.owner || /^unassigned/i.test(entry.owner))
      lines.push('          WARNING: nobody owns this exception - name an owner');
    if (daysLeft <= 30)
      lines.push(
        `          WARNING: this exception expires soon - decide whether to fix it or renew it`,
      );
  }
  for (const e of result.unused)
    lines.push(`unused    ${e.id}  matches nothing in this audit any more - delete the entry`);
  lines.push(
    '',
    `${result.blocking.length} blocking, ${result.allowed.length} accepted, ${result.belowThreshold} below "${threshold}".`,
  );
  return lines.join('\n');
}

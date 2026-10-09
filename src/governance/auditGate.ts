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

/** The advisories in `npm audit --json` output (report version 2), one per advisory and package. */
export function parseAudit(audit: unknown): Advisory[] {
  const vulnerabilities = ((audit as { vulnerabilities?: Record<string, { via?: unknown[] }> })
    .vulnerabilities ?? {}) as Record<string, { via?: unknown[] }>;
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

export function loadAllowlist(file: string): Allowlist {
  if (!fs.existsSync(file)) return { allow: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Allowlist;
  for (const entry of parsed.allow ?? []) {
    if (!entry.id || !entry.reason || !entry.expires)
      throw new Error(
        `every allowlist entry needs "id", "reason" and "expires" (found ${JSON.stringify(entry)})`,
      );
  }
  return { allow: parsed.allow ?? [] };
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

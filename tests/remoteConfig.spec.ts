import * as path from 'node:path';
import { inspect } from 'node:util';
import { expect, test } from '@playwright/test';
import { RemoteConfig, remoteConfigFromEnv } from '../src/remote/config';
import { reader } from './support/remoteFixtures';

const SECRET = 'Pa55w0rd-do-not-print';
const base = { REMOTE_ENABLED: 'true', REMOTE_RDP_HOST: 'rdp-host.test', REMOTE_AGENT_START: 'manual' };

const fromEnv = (values: Record<string, string>) => remoteConfigFromEnv(reader({ ...base, ...values }));
const message = (values: Record<string, string>) => {
  try {
    fromEnv(values);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected remoteConfigFromEnv to throw');
};

test.describe('remoteConfigFromEnv', () => {
  test('is undefined unless REMOTE_ENABLED is true - the callers then use their local services', () => {
    expect(remoteConfigFromEnv(reader({}))).toBeUndefined();
    expect(remoteConfigFromEnv(reader({ REMOTE_ENABLED: 'false', REMOTE_RDP_HOST: 'h' }))).toBeUndefined();
    expect(remoteConfigFromEnv(reader({ REMOTE_ENABLED: 'no' }))).toBeUndefined(); // and the host is not even looked at
  });

  test('REMOTE_ENABLED is a strict boolean: a typo does not silently disable the remote host', () => {
    expect(() => remoteConfigFromEnv(reader({ REMOTE_ENABLED: 'ture' }))).toThrow(/REMOTE_ENABLED.*not a valid boolean/);
  });

  test('defaults', () => {
    const config = fromEnv({}) as RemoteConfig;
    expect(config).toMatchObject({
      host: 'rdp-host.test',
      port: 3389,
      driveLetter: 'R',
      agentStart: 'manual',
      allow: ['http', 'db', 'sap'],
      connectTimeoutMs: 180_000,
      requestTimeoutMs: 60_000,
      pollMs: 200,
      heartbeatMs: 2000,
      heartbeatStaleMs: 10_000,
      width: 1280,
      height: 800,
      keepOpen: false,
      logoff: false,
    });
    expect(config.shareDir).toBe(path.join(process.cwd(), '.remote-mailbox'));
    expect(config.allow).not.toContain('exec'); // exec must be listed explicitly
    expect(config.remoteRoot).toBe('\\\\tsclient\\R');
  });

  test('every key is read', () => {
    const config = fromEnv({
      REMOTE_RDP_PORT: '3390',
      REMOTE_RDP_USER: 'svc',
      REMOTE_RDP_PASSWORD: SECRET,
      REMOTE_RDP_DOMAIN: 'CORP',
      REMOTE_SHARE_DIR: '/tmp/mailbox-x',
      REMOTE_DRIVE_LETTER: 'q',
      REMOTE_AGENT_START: 'startup',
      REMOTE_ALLOW: 'http, exec',
      REMOTE_CONNECT_TIMEOUT_MS: '1000',
      REMOTE_REQUEST_TIMEOUT_MS: '2000',
      REMOTE_POLL_MS: '50',
      REMOTE_HEARTBEAT_MS: '500',
      REMOTE_HEARTBEAT_STALE_MS: '3000',
      REMOTE_RDP_WIDTH: '1024',
      REMOTE_RDP_HEIGHT: '768',
      REMOTE_RDP_KEEP_OPEN: 'yes',
      REMOTE_LOGOFF: '1',
      REMOTE_DB_PROVIDER: 'System.Data.Odbc',
      REMOTE_DB_CONNECTION_STRING: `DSN=x;PWD=${SECRET}`,
    }) as RemoteConfig;
    expect(config).toMatchObject({ port: 3390, user: 'svc', domain: 'CORP', driveLetter: 'Q', agentStart: 'startup', allow: ['http', 'exec'], connectTimeoutMs: 1000, requestTimeoutMs: 2000, pollMs: 50, heartbeatMs: 500, heartbeatStaleMs: 3000, width: 1024, height: 768, keepOpen: true, logoff: true, dbProvider: 'System.Data.Odbc' });
    expect(config.password).toBe(SECRET);
    expect(config.dbConnectionString).toContain('DSN=x');
    expect(config.qualifiedUser).toBe('CORP\\svc');
  });

  test('the host is required and must be a bare host name', () => {
    expect(() => remoteConfigFromEnv(reader({ REMOTE_ENABLED: 'true' }))).toThrow(/REMOTE_RDP_HOST is required/);
    expect(message({ REMOTE_RDP_HOST: 'rdp://host' })).toMatch(/REMOTE_RDP_HOST.*without a scheme/);
    expect(message({ REMOTE_RDP_HOST: 'host name' })).toMatch(/REMOTE_RDP_HOST/);
  });

  test('alternate-shell logs in for you, so it needs the user and the password; startup / manual do not', () => {
    expect(message({ REMOTE_AGENT_START: 'alternate-shell' })).toMatch(/REMOTE_RDP_USER and REMOTE_RDP_PASSWORD are required/);
    expect(message({ REMOTE_AGENT_START: 'alternate-shell', REMOTE_RDP_USER: 'u' })).toMatch(/required/);
    expect(fromEnv({ REMOTE_AGENT_START: 'alternate-shell', REMOTE_RDP_USER: 'u', REMOTE_RDP_PASSWORD: 'p' })).toBeDefined();
    expect(fromEnv({ REMOTE_AGENT_START: 'startup' })).toBeDefined();
    expect(message({ REMOTE_AGENT_START: 'automatic' })).toMatch(/REMOTE_AGENT_START "automatic" is not one of: alternate-shell, startup, manual/);
  });

  test('DOMAIN\\user is split; a contradicting REMOTE_RDP_DOMAIN is an error; user@domain is left alone', () => {
    const split = fromEnv({ REMOTE_RDP_USER: 'CORP\\jdoe' }) as RemoteConfig;
    expect(split).toMatchObject({ user: 'jdoe', domain: 'CORP' });
    expect(split.qualifiedUser).toBe('CORP\\jdoe');
    expect((fromEnv({ REMOTE_RDP_USER: 'corp\\jdoe', REMOTE_RDP_DOMAIN: 'CORP' }) as RemoteConfig).domain).toBe('corp');
    expect(message({ REMOTE_RDP_USER: 'CORP\\jdoe', REMOTE_RDP_DOMAIN: 'OTHER' })).toMatch(/names the domain "CORP" but REMOTE_RDP_DOMAIN is "OTHER"/);
    const upn = fromEnv({ REMOTE_RDP_USER: 'jdoe@corp.example' }) as RemoteConfig;
    expect(upn.user).toBe('jdoe@corp.example');
    expect(upn.domain).toBeUndefined();
  });

  test('the drive letter must be one letter and never a real system drive', () => {
    expect(message({ REMOTE_DRIVE_LETTER: 'RR' })).toMatch(/REMOTE_DRIVE_LETTER "RR" must be a single letter/);
    expect(message({ REMOTE_DRIVE_LETTER: '1' })).toMatch(/single letter/);
    expect(message({ REMOTE_DRIVE_LETTER: 'c' })).toMatch(/would shadow a real drive/);
    expect((fromEnv({ REMOTE_DRIVE_LETTER: 'x' }) as RemoteConfig).driveLetter).toBe('X');
  });

  test('REMOTE_ALLOW: unknown entries are rejected, case and duplicates are tolerated, exec only when listed', () => {
    expect(message({ REMOTE_ALLOW: 'http,ftp' })).toMatch(/entry "ftp" is not one of: http, db, sap, exec/);
    expect((fromEnv({ REMOTE_ALLOW: 'HTTP, http ,DB' }) as RemoteConfig).allow).toEqual(['http', 'db']);
    expect((fromEnv({ REMOTE_ALLOW: 'http,db,sap,exec' }) as RemoteConfig).allow).toContain('exec');
  });

  test('numbers are validated with the setting named', () => {
    expect(message({ REMOTE_RDP_PORT: '99999' })).toMatch(/REMOTE_RDP_PORT must be a whole number between 1 and 65535/);
    expect(message({ REMOTE_RDP_PORT: '33x' })).toMatch(/REMOTE_RDP_PORT.*not a valid integer/);
    expect(message({ REMOTE_POLL_MS: '1' })).toMatch(/REMOTE_POLL_MS/);
    expect(message({ REMOTE_HEARTBEAT_MS: '2000', REMOTE_HEARTBEAT_STALE_MS: '3000' })).toMatch(/at least twice REMOTE_HEARTBEAT_MS/);
    expect(message({ REMOTE_RDP_WIDTH: '10' })).toMatch(/REMOTE_RDP_WIDTH/);
  });
});

test.describe('secrets never leak from the config', () => {
  const secretConfig = () =>
    fromEnv({ REMOTE_AGENT_START: 'alternate-shell', REMOTE_RDP_USER: 'svc', REMOTE_RDP_PASSWORD: SECRET, REMOTE_DB_CONNECTION_STRING: `Server=s;Password=${SECRET}` }) as RemoteConfig;

  test('toJSON, JSON.stringify, util.inspect, spread and Object.keys mask or omit them', () => {
    const config = secretConfig();
    expect(config.toJSON()).toMatchObject({ password: '********', dbConnectionString: '********', user: 'svc' });
    for (const text of [JSON.stringify(config), inspect(config, { depth: 5 }), `${JSON.stringify({ ...config })}`, Object.keys(config).join(','), JSON.stringify(Object.entries(config))])
      expect(text).not.toContain(SECRET);
    expect(inspect(config)).toContain('********');
    expect(config.password).toBe(SECRET); // the launcher still has it
  });

  test('no validation message contains a secret, even when another setting is wrong', () => {
    const messages = [
      message({ REMOTE_RDP_PASSWORD: SECRET, REMOTE_RDP_PORT: 'abc' }),
      message({ REMOTE_RDP_PASSWORD: SECRET, REMOTE_DRIVE_LETTER: 'ZZ' }),
      message({ REMOTE_RDP_PASSWORD: SECRET, REMOTE_DB_CONNECTION_STRING: `Password=${SECRET}`, REMOTE_ALLOW: 'bogus' }),
      message({ REMOTE_AGENT_START: 'alternate-shell', REMOTE_RDP_PASSWORD: SECRET }), // user missing
    ];
    for (const text of messages) expect(text).not.toContain(SECRET);
  });
});

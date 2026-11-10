import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';

test('OAuth and analytics default pools retain hidden database credentials and connection limits', async () => {
  // Initialize real pg pools with fixture settings; never open a database connection.
  Object.assign(process.env, { DB_HOST: 'fixture.invalid', DB_PORT: '5432',
    DB_NAME: 'fixture_db', DB_USER: 'fixture_user', DB_PASSWORD: 'fixture-password' });
  const { default: shared } = await import('../src/services/database.js');
  assert.equal(Object.getOwnPropertyDescriptor(shared.options, 'password').enumerable, false);
  const { default: McpOAuthService } = await import('../src/services/mcpOAuthService.js');
  const { default: PublicAnalyticsApiService } = await import('../src/services/publicAnalyticsApiService.js');
  const oauth = new McpOAuthService({});
  const analytics = new PublicAnalyticsApiService();
  try {
    for (const [database, max] of [[oauth.database, 4], [analytics.database, 2]]) {
      assert.notEqual(database, shared);
      const client = new Client(database.options);
      assert.equal(client.password, 'fixture-password');
      assert.equal(client.host, 'fixture.invalid');
      assert.equal(client.database, 'fixture_db');
      assert.equal(client.user, 'fixture_user');
      assert.equal(database.options.max, max);
      assert.equal(database.options.connectionTimeoutMillis, 5000);
      assert.equal(Object.getOwnPropertyDescriptor(database.options, 'password').enumerable, false);
      assert.equal(JSON.stringify(database.options).includes('fixture-password'), false);
    }
    assert.equal(oauth.database.options.statement_timeout, 5000);
    assert.equal(shared.options.connectionTimeoutMillis, undefined);
  } finally {
    await Promise.all([shared.end(), oauth.database.end(), analytics.database.end()]);
  }
});

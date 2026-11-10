import test from 'node:test';
import assert from 'node:assert/strict';
import { publicApiDiagnostics, publicApiError, reportApiError } from '../src/middleware/publicApiDiagnostics.js';

test('public errors correlate server-generated response IDs and safe logs without logging secrets', () => {
  const logs = [], headers = {}, req = { method: 'GET', route: { path: '/workouts/:id' },
    headers: { authorization: 'Bearer PRIVATE', 'x-request-id': 'FORGED' },
    originalUrl: '/workouts/PRIVATE?token=PRIVATE', body: { secret: 'PRIVATE' }, user: { email: 'PRIVATE' } };
  const res = { set: (key, value) => { headers[key] = value; }, status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; } };
  publicApiDiagnostics('workouts', entry => logs.push(entry))(req, res, () => {});
  const failure = Object.assign(new Error('PRIVATE password, SQL and connection details'), { code: '28P01', detail: 'PRIVATE', stack: 'PRIVATE' });
  publicApiError(req, res, 503, 'service_unavailable', 'API service unavailable.', failure);
  assert.match(headers['X-Request-ID'], /^[a-f0-9-]{36}$/);
  assert.equal(res.body.error.request_id, headers['X-Request-ID']);
  assert.equal(logs[0].request_id, headers['X-Request-ID']);
  assert.equal(logs[0].reason, '28P01');
  assert.equal(logs[0].route, '/workouts/:id');
  assert.doesNotMatch(JSON.stringify({ logs, response: res.body }), /PRIVATE|FORGED/);
  reportApiError(req, 503, 'service_unavailable', new Error('SASL: client password must be a string PRIVATE'));
  assert.equal(logs.at(-1).reason, 'database_password_type');
  req.route.path = '/PRIVATE'; req.method = 'PRIVATE';
  reportApiError(req, 503, 'service_unavailable', { code: 'PRIVATE' });
  assert.equal(logs.at(-1).route, null); assert.equal(logs.at(-1).method, 'OTHER');
  assert.equal(logs.at(-1).reason, 'unexpected_error');
});

test('diagnostic logger failure does not replace the API response', () => {
  const req = { method: 'GET' }, res = { set() {}, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
  publicApiDiagnostics('analytics', () => { throw new Error('logger unavailable'); })(req, res, () => {});
  publicApiError(req, res, 429, 'rate_limited', 'Request allowance exceeded.');
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error.code, 'rate_limited');
  assert.match(res.body.error.request_id, /^[a-f0-9-]{36}$/);
});

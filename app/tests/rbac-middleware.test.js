/**
 * requirePerm middleware tests. This is what enforces that a role without
 * `photos.favorite` can't POST /fav/:id (the sprint bug that let anyone
 * favourite regardless of role). No real HTTP — we drive the middleware with
 * plain mock req/res objects.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { requirePerm } = require('../src/middleware/auth');

function mockReq(user) {
  return { user, originalUrl: '/api/aurora/fav/1', headers: {} };
}
function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('requirePerm calls next() when the user holds the permission', () => {
  const mw = requirePerm('photos.favorite');
  const req = mockReq({ userId: 1, username: 'alice', permissions: ['photos.favorite', 'photos.view'] });
  const res = mockRes();
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
});

test('requirePerm returns 403 when the user lacks the permission', () => {
  const mw = requirePerm('photos.favorite');
  const req = mockReq({ userId: 2, username: 'bob', permissions: ['photos.view'] });
  const res = mockRes();
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, false, 'next() must not run');
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /photos\.favorite/);
});

test('requirePerm returns 401 (JSON API path) when there is no session', () => {
  const mw = requirePerm('photos.favorite');
  const req = mockReq(null);
  const res = mockRes();
  let called = false;
  // originalUrl starts with /api/ so requireAuth chooses JSON 401 not redirect.
  mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('requirePerm handles a user with an empty permissions array', () => {
  const mw = requirePerm('photos.view');
  const req = mockReq({ userId: 3, username: 'nopriv', permissions: [] });
  const res = mockRes();
  mw(req, res, () => { throw new Error('next() must not run'); });
  assert.equal(res.statusCode, 403);
});

test('each perm has its own middleware — one failure does not affect another', () => {
  const favMw = requirePerm('photos.favorite');
  const tagMw = requirePerm('photos.tag');
  const req = mockReq({ userId: 4, username: 'partial', permissions: ['photos.favorite'] });

  let favCalled = false, tagCalled = false;
  favMw(req, mockRes(), () => { favCalled = true; });
  tagMw(req, mockRes(), () => { tagCalled = true; });

  assert.equal(favCalled, true);
  assert.equal(tagCalled, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticatedUser,
  hasExpectedUserContext,
  isValidAuthenticatedUserId,
  MAX_AUTHENTICATED_EMAIL_LENGTH,
  MAX_AUTHENTICATED_USER_ID_LENGTH,
  storageKeyForUser,
} from './user-scope.ts';

test('登录用户必须拥有平台提供的稳定用户 ID', () => {
  const anonymous = new Request('https://example.com/api/state', {
    headers: { 'oai-authenticated-user-email': 'person@example.com' },
  });
  assert.equal(authenticatedUser(anonymous), null);

  const signedIn = new Request('https://example.com/api/state', {
    headers: {
      'oai-authenticated-user-id': ' user-a ',
      'oai-authenticated-user-email': ' person@example.com ',
    },
  });
  assert.deepEqual(authenticatedUser(signedIn), {
    id: 'user-a',
    email: 'person@example.com',
  });
});

test('不同用户始终使用不同的浏览器缓存空间', () => {
  assert.notEqual(storageKeyForUser('user-a'), storageKeyForUser('user-b'));
  assert.notEqual(storageKeyForUser('user-a'), storageKeyForUser('user-a/other-site'));
  assert.match(storageKeyForUser('user-a/other-site'), /user-a%2Fother-site$/);
});

test('邮箱相同也不能替代用户 ID 作为隔离边界', () => {
  const first = authenticatedUser(new Request('https://example.com/api/state', {
    headers: {
      'oai-authenticated-user-id': 'account-one',
      'oai-authenticated-user-email': 'shared@example.com',
    },
  }));
  const second = authenticatedUser(new Request('https://example.com/api/state', {
    headers: {
      'oai-authenticated-user-id': 'account-two',
      'oai-authenticated-user-email': 'shared@example.com',
    },
  }));

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(storageKeyForUser(first.id), storageKeyForUser(second.id));
});

test('空用户 ID 不允许生成缓存键', () => {
  assert.throws(() => storageKeyForUser('   '), /user ID is invalid/);
});

test('认证 ID 拒绝超长值和控制字符', () => {
  assert.equal(isValidAuthenticatedUserId('a'.repeat(MAX_AUTHENTICATED_USER_ID_LENGTH)), true);
  assert.equal(isValidAuthenticatedUserId('a'.repeat(MAX_AUTHENTICATED_USER_ID_LENGTH + 1)), false);
  assert.equal(isValidAuthenticatedUserId('user-a\u007fadmin'), false);

  const oversized = new Request('https://example.com/api/state', {
    headers: { 'oai-authenticated-user-id': 'a'.repeat(MAX_AUTHENTICATED_USER_ID_LENGTH + 1) },
  });
  assert.equal(authenticatedUser(oversized), null);
});

test('超长邮箱不会变成权限边界', () => {
  const request = new Request('https://example.com/api/state', {
    headers: {
      'oai-authenticated-user-id': 'user-a',
      'oai-authenticated-user-email': 'a'.repeat(MAX_AUTHENTICATED_EMAIL_LENGTH + 1),
    },
  });
  assert.deepEqual(authenticatedUser(request), { id: 'user-a', email: '' });
});

test('写入前的预期账号必须与当前认证 ID 完全一致', () => {
  const matching = new Request('https://example.com/api/state', {
    headers: { 'x-expected-user-id': 'user-a' },
  });
  const switched = new Request('https://example.com/api/state', {
    headers: { 'x-expected-user-id': 'user-b' },
  });
  const missing = new Request('https://example.com/api/state');
  assert.equal(hasExpectedUserContext(matching, 'user-a'), true);
  assert.equal(hasExpectedUserContext(switched, 'user-a'), false);
  assert.equal(hasExpectedUserContext(missing, 'user-a'), false);
});

import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FAKE_IDP_CLIENT_ID,
  startFakeIdp,
  type FakeIdp,
} from '../../../support/fake-idp.js';

const REDIRECT_URI = 'http://localhost:3000/api/auth/callback/corp';
let idp: FakeIdp;
beforeAll(async () => {
  idp = await startFakeIdp({ redirectUri: REDIRECT_URI });
});
afterAll(async () => idp?.close());

it.each([
  [REDIRECT_URI, 'email openid profile', 302],
  ['https://unregistered.example/callback', 'openid', 400],
  [REDIRECT_URI + '/extra', 'openid', 400],
  [REDIRECT_URI, 'email profile', 400],
  [REDIRECT_URI, 'not-openid', 400],
  [REDIRECT_URI, '', 400],
])(
  'authorize redirect=%s scope=%s → %s',
  async (redirectUri, scope, status) => {
    const url = new URL('/authorize', idp.url);
    url.search = new URLSearchParams({
      client_id: FAKE_IDP_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope,
      state: 'state',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
    }).toString();
    const response = await fetch(url, { redirect: 'manual' });
    expect(response.status).toBe(status);
    if (status === 400) {
      expect(response.headers.get('location')).toBeNull();
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    } else {
      const callback = new URL(response.headers.get('location')!);
      expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
      expect(callback.searchParams.get('code')).toBeTruthy();
    }
  },
);

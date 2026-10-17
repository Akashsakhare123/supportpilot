import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  createTestApp,
  createTestTenant,
  refreshCookieFrom,
  TEST_PASSWORD,
  type TestTenant,
} from './helpers';

describe('Auth with roles (T02)', () => {
  let app: INestApplication;
  let t: TestTenant;
  let other: TestTenant;
  const http = () => request(app.getHttpServer());

  async function login(email: string, password = TEST_PASSWORD) {
    return http().post('/auth/login').send({ email, password });
  }

  beforeAll(async () => {
    app = await createTestApp();
    t = await createTestTenant('Acme');
    other = await createTestTenant('Globex');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('login', () => {
    it('rejects a wrong password and an unknown email with the same 401', async () => {
      const wrong = await login(t.owner.email, 'not-the-password');
      const unknown = await login('nobody@example.test');
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.message).toEqual(unknown.body.message);
    });

    it('rejects an invalid body with 400', async () => {
      await http().post('/auth/login').send({ email: 'not-an-email' }).expect(400);
    });

    it('returns an access token, the user and an httpOnly refresh cookie', async () => {
      const res = await login(t.owner.email.toUpperCase());
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.user).toMatchObject({
        email: t.owner.email,
        role: 'owner',
        tenant: { id: t.tenantId },
      });
      const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      expect(setCookie.join(';')).toMatch(/sp_refresh=.+HttpOnly/i);
    });

    it('never returns a password hash', async () => {
      const res = await login(t.owner.email);
      expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/i);
    });
  });

  describe('roles', () => {
    it('requires a token for protected routes', async () => {
      await http().get('/auth/me').expect(401);
      await http().get('/users').expect(401);
    });

    it('gives an agent 403 on an admin-only route', async () => {
      const { body } = await login(t.agent.email);
      await http().get('/users').set('Authorization', `Bearer ${body.accessToken}`).expect(403);
    });

    it('lets admins and owners list only their own team, without password hashes', async () => {
      for (const email of [t.admin.email, t.owner.email]) {
        const { body } = await login(email);
        const res = await http()
          .get('/users')
          .set('Authorization', `Bearer ${body.accessToken}`)
          .expect(200);
        const emails = (res.body as { email: string }[]).map((u) => u.email).sort();
        expect(emails).toEqual([t.admin.email, t.agent.email, t.owner.email].sort());
        expect(emails).not.toContain(other.owner.email);
        expect(JSON.stringify(res.body)).not.toMatch(/password/i);
      }
    });
  });

  describe('refresh token rotation', () => {
    it('rotates the cookie and returns a fresh access token', async () => {
      const first = refreshCookieFrom((await login(t.owner.email)).headers['set-cookie']);
      expect(first).toBeDefined();
      const res = await http().post('/auth/refresh').set('Cookie', first!).expect(200);
      const second = refreshCookieFrom(res.headers['set-cookie']);
      expect(second).toBeDefined();
      expect(second).not.toEqual(first);
      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
    });

    it('revokes the whole session when an old refresh token is replayed later', async () => {
      const first = refreshCookieFrom((await login(t.owner.email)).headers['set-cookie'])!;
      const rotated = await http().post('/auth/refresh').set('Cookie', first).expect(200);
      const second = refreshCookieFrom(rotated.headers['set-cookie'])!;

      // Simulate a stolen token replayed after the grace window by backdating the revocation.
      await backdateRevocations();
      await http().post('/auth/refresh').set('Cookie', first).expect(401);
      // The legitimate holder of the newest token is logged out too (family revoked).
      await http().post('/auth/refresh').set('Cookie', second).expect(401);
    });

    it('logout invalidates the refresh token', async () => {
      const cookie = refreshCookieFrom((await login(t.agent.email)).headers['set-cookie'])!;
      await http().post('/auth/logout').set('Cookie', cookie).expect(204);
      await http().post('/auth/refresh').set('Cookie', cookie).expect(401);
    });

    it('rejects a refresh without a cookie', async () => {
      await http().post('/auth/refresh').expect(401);
    });
  });

  describe('invites', () => {
    it('lets an owner invite an agent who can then sign in', async () => {
      const { body: session } = await login(t.owner.email);
      const email = `new-agent-${Date.now()}@example.test`;
      const created = await http()
        .post('/users/invites')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ email, role: 'agent' })
        .expect(201);
      const token = String(created.body.inviteUrl).split('/invite/')[1]!;

      const preview = await http().get(`/auth/invites/${token}`).expect(200);
      expect(preview.body).toMatchObject({ email, role: 'agent' });

      const accepted = await http()
        .post('/auth/invites/accept')
        .send({ token, name: 'New Agent', password: 'a-long-password' })
        .expect(200);
      expect(accepted.body.user).toMatchObject({
        email,
        role: 'agent',
        tenant: { id: t.tenantId },
      });

      await http().get(`/auth/invites/${token}`).expect(410); // single use
      await login(email, 'a-long-password').then((r) => expect(r.status).toBe(200));
    });

    it('does not let an admin invite another admin', async () => {
      const { body: session } = await login(t.admin.email);
      await http()
        .post('/users/invites')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ email: `x-${Date.now()}@example.test`, role: 'admin' })
        .expect(403);
    });

    it('does not let an agent invite anyone', async () => {
      const { body: session } = await login(t.agent.email);
      await http()
        .post('/users/invites')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ email: `y-${Date.now()}@example.test`, role: 'agent' })
        .expect(403);
    });
  });
});

/** Push every revocation 1 minute into the past so replays fall outside the grace window. */
async function backdateRevocations(): Promise<void> {
  const { createPool } = await import('@supportpilot/db');
  const pool = createPool(process.env.DATABASE_URL!, { max: 1 });
  try {
    await pool.query(
      "update refresh_tokens set revoked_at = revoked_at - interval '1 minute' where revoked_at is not null",
    );
  } finally {
    await pool.end();
  }
}

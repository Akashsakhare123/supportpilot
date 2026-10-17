import type { INestApplication } from '@nestjs/common';
import { PUBLIC_KEY_PATTERN } from '@supportpilot/shared';
import request from 'supertest';
import {
  createTestApp,
  createTestTenant,
  refreshCookieFrom,
  TEST_PASSWORD,
  type TestTenant,
} from './helpers';

describe('Tenant onboarding (T03)', () => {
  let app: INestApplication;
  let t: TestTenant;
  const http = () => request(app.getHttpServer());

  async function tokenFor(email: string): Promise<string> {
    const res = await http()
      .post('/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    app = await createTestApp();
    t = await createTestTenant('Onboard');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('signup', () => {
    const unique = () => `founder-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.test`;

    it('creates a tenant with a widget key and its owner, and signs them in', async () => {
      const email = unique();
      const res = await http()
        .post('/auth/signup')
        .send({
          companyName: 'Bright Bakery',
          name: 'Bea Baker',
          email,
          password: 'a-long-password',
        })
        .expect(201);
      expect(res.body.user).toMatchObject({
        email,
        role: 'owner',
        tenant: { name: 'Bright Bakery', onboarded: false },
      });
      expect(refreshCookieFrom(res.headers['set-cookie'])).toBeDefined();

      const settings = await http()
        .get('/tenant')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
      expect(settings.body.publicKey).toMatch(PUBLIC_KEY_PATTERN);
      expect(settings.body.publicKey.startsWith('pk_live_')).toBe(true);
      expect(settings.body.branding).toMatchObject({ position: 'right' });
    });

    it('rejects a duplicate email with 409 and an invalid body with 400', async () => {
      const email = unique();
      const body = { companyName: 'Dup Co', name: 'Dee', email, password: 'a-long-password' };
      await http().post('/auth/signup').send(body).expect(201);
      await http().post('/auth/signup').send(body).expect(409);
      await http()
        .post('/auth/signup')
        .send({ ...body, email: unique(), password: 'short' })
        .expect(400);
    });
  });

  describe('settings', () => {
    it('lets admins update branding and domains, normalising domains', async () => {
      const token = await tokenFor(t.admin.email);
      const res = await http()
        .patch('/tenant')
        .set('Authorization', `Bearer ${token}`)
        .send({
          branding: {
            primaryColor: '#0f766e',
            logoUrl: '',
            greeting: 'Hey there',
            position: 'left',
          },
          allowedDomains: ['https://Shop.Example.com/home', 'localhost:5173'],
        })
        .expect(200);
      expect(res.body.branding).toMatchObject({ primaryColor: '#0f766e', position: 'left' });
      expect(res.body.allowedDomains).toEqual(['shop.example.com', 'localhost']);
    });

    it('rejects unknown fields so the plan or key cannot be changed through PATCH', async () => {
      const token = await tokenFor(t.owner.email);
      await http()
        .patch('/tenant')
        .set('Authorization', `Bearer ${token}`)
        .send({ plan: 'business' })
        .expect(400);
    });

    it('marks onboarding complete, visible in /auth/me', async () => {
      const token = await tokenFor(t.owner.email);
      await http()
        .patch('/tenant')
        .set('Authorization', `Bearer ${token}`)
        .send({ onboardingCompleted: true })
        .expect(200);
      const me = await http().get('/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
      expect(me.body.tenant.onboarded).toBe(true);
    });

    it('keeps settings away from agents', async () => {
      const token = await tokenFor(t.agent.email);
      await http().get('/tenant').set('Authorization', `Bearer ${token}`).expect(403);
      await http()
        .post('/tenant/public-key/rotate')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  describe('public widget config', () => {
    let key: string;
    let ownerToken: string;

    beforeAll(async () => {
      ownerToken = await tokenFor(t.owner.email);
      const res = await http()
        .patch('/tenant')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ allowedDomains: ['shop.example.com'] })
        .expect(200);
      key = res.body.publicKey;
    });

    it('returns only public fields', async () => {
      const res = await http().get(`/widget/config?key=${key}`).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['branding', 'tenantName']);
      expect(JSON.stringify(res.body)).not.toContain(key);
      expect(res.headers['cache-control']).toContain('max-age=60');
    });

    it('is callable from any website via CORS, but enforces the allowed domains', async () => {
      const ok = await http()
        .get(`/widget/config?key=${key}`)
        .set('Origin', 'https://www.shop.example.com')
        .expect(200);
      expect(ok.headers['access-control-allow-origin']).toBe('https://www.shop.example.com');
      expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
      await http().get(`/widget/config?key=${key}`).set('Origin', 'https://evil.test').expect(403);
    });

    it('answers CORS preflight for widget routes from any origin', async () => {
      const res = await http()
        .options(`/widget/config?key=${key}`)
        .set('Origin', 'https://anywhere.test')
        .set('Access-Control-Request-Method', 'GET');
      expect(res.status).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe('https://anywhere.test');
    });

    it('does not open CORS for dashboard routes to other sites', async () => {
      const res = await http().get('/health').set('Origin', 'https://evil.test');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rejects missing, malformed and unknown keys', async () => {
      await http().get('/widget/config').expect(400);
      await http().get('/widget/config?key=sk_live_secret').expect(400);
      await http().get('/widget/config?key=pk_live_doesnotexist123').expect(404);
    });

    it('rotating the key invalidates the old one immediately', async () => {
      const rotated = await http()
        .post('/tenant/public-key/rotate')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      const newKey = rotated.body.publicKey as string;
      expect(newKey).not.toEqual(key);
      await http().get(`/widget/config?key=${key}`).expect(404);
      await http().get(`/widget/config?key=${newKey}`).expect(200);
      key = newKey;
    });
  });

  it('GET / describes the API instead of returning 404', async () => {
    const res = await http().get('/').expect(200);
    expect(res.body).toMatchObject({ name: 'SupportPilot API', health: '/health' });
  });
});

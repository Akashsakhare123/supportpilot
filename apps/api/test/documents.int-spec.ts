import type { INestApplication } from '@nestjs/common';
import { QUEUES } from '@supportpilot/shared';
import { Queue } from 'bullmq';
import { redisOptionsFromUrl } from '@supportpilot/shared/node';
import request from 'supertest';
import { createTestApp, createTestTenant, TEST_PASSWORD, type TestTenant } from './helpers';

describe('Knowledge base upload (T04)', () => {
  let app: INestApplication;
  let t: TestTenant;
  let other: TestTenant;
  let admin: string;
  let queue: Queue;
  const http = () => request(app.getHttpServer());

  async function tokenFor(email: string): Promise<string> {
    const res = await http()
      .post('/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function queuedDocumentIds(): Promise<string[]> {
    const jobs = await queue.getJobs([
      'waiting',
      'delayed',
      'prioritized',
      'active',
      'completed',
      'failed',
    ]);
    return jobs.map((job) => (job?.data as { documentId: string } | undefined)?.documentId ?? '');
  }

  beforeAll(async () => {
    app = await createTestApp();
    t = await createTestTenant('KB');
    other = await createTestTenant('OtherKB');
    admin = await tokenFor(t.admin.email);
    queue = new Queue(QUEUES.ingestion, {
      connection: redisOptionsFromUrl(process.env.REDIS_URL!),
    });
  });

  afterAll(async () => {
    await queue?.close();
    await app?.close();
  });

  it('uploads a markdown file, stores it as queued and enqueues ingestion', async () => {
    const res = await http()
      .post('/documents')
      .set('Authorization', `Bearer ${admin}`)
      .attach(
        'file',
        Buffer.from('# Returns\nYou can return bikes within 30 days.'),
        'returns-policy.md',
      )
      .expect(201);
    expect(res.body).toMatchObject({
      title: 'returns policy',
      sourceType: 'text',
      source: 'returns-policy.md',
      status: 'queued',
      chunkCount: 0,
    });
    expect(await queuedDocumentIds()).toContain(res.body.id);
  });

  it('accepts a real PDF header and uses a custom title', async () => {
    const res = await http()
      .post('/documents')
      .set('Authorization', `Bearer ${admin}`)
      .field('title', 'Warranty terms')
      .attach('file', Buffer.from('%PDF-1.4\n%fake but valid header\n'), 'warranty.pdf')
      .expect(201);
    expect(res.body).toMatchObject({ title: 'Warranty terms', sourceType: 'pdf' });
  });

  it('rejects disguised, unsupported and missing files with 400', async () => {
    const send = (data: Buffer, name: string) =>
      http().post('/documents').set('Authorization', `Bearer ${admin}`).attach('file', data, name);
    await send(Buffer.from('MZ\x90\x00 an exe'), 'manual.pdf').expect(400);
    await send(Buffer.from('MZ'), 'setup.exe').expect(400);
    await http().post('/documents').set('Authorization', `Bearer ${admin}`).expect(400);
  });

  it('queues a public URL', async () => {
    const res = await http()
      .post('/documents/url')
      .set('Authorization', `Bearer ${admin}`)
      .send({ url: 'https://example.com/help' })
      .expect(201);
    expect(res.body).toMatchObject({
      sourceType: 'url',
      source: 'https://example.com/help',
      status: 'queued',
    });
  });

  it.each([
    'http://127.0.0.1:4000/health',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:5434/',
    'http://10.0.0.5/admin',
    'file:///etc/passwd',
  ])('blocks SSRF target %s with 400', async (url) => {
    await http()
      .post('/documents/url')
      .set('Authorization', `Bearer ${admin}`)
      .send({ url })
      .expect(400);
  });

  it('lists only the caller tenant documents and hides other tenants (404)', async () => {
    const otherAdmin = await tokenFor(other.admin.email);
    const mine = await http().get('/documents').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(mine.body.length).toBeGreaterThanOrEqual(3);
    const theirs = await http()
      .get('/documents')
      .set('Authorization', `Bearer ${otherAdmin}`)
      .expect(200);
    expect(theirs.body).toEqual([]);

    const id = mine.body[0].id as string;
    await http()
      .delete(`/documents/${id}`)
      .set('Authorization', `Bearer ${otherAdmin}`)
      .expect(404);
    await http()
      .post(`/documents/${id}/reindex`)
      .set('Authorization', `Bearer ${otherAdmin}`)
      .expect(404);
  });

  it('re-indexes and deletes a document', async () => {
    const created = await http()
      .post('/documents')
      .set('Authorization', `Bearer ${admin}`)
      .attach('file', Buffer.from('temporary'), 'temp.txt')
      .expect(201);
    const id = created.body.id as string;
    await http()
      .post(`/documents/${id}/reindex`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    await http().delete(`/documents/${id}`).set('Authorization', `Bearer ${admin}`).expect(204);
    const list = await http().get('/documents').set('Authorization', `Bearer ${admin}`).expect(200);
    expect((list.body as { id: string }[]).map((d) => d.id)).not.toContain(id);
  });

  it('keeps the knowledge base away from agents', async () => {
    const agent = await tokenFor(t.agent.email);
    await http().get('/documents').set('Authorization', `Bearer ${agent}`).expect(403);
  });
});

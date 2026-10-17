// Demo data for local development and the live demo: tenant "Acme Bikes" with one user per role.
// Safe to run repeatedly: creates what is missing and keeps the demo tenant's settings current.
// The sample knowledge base in seed-data/acme-bikes is stored, chunked and embedded directly
// (no worker needed), so the demo tenant can answer questions right after seeding.
import { hash } from '@node-rs/argon2';
import { createEmbeddingProvider, embedDocument } from '@supportpilot/ai';
import { DEFAULT_BRANDING } from '@supportpilot/shared';
import { LocalFileStorage, loadDotEnv, resolveStorageDir } from '@supportpilot/shared/node';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceDocumentChunks } from './chunks';
import { createDb, createPool, type Database } from './index';
import { documents, tenants, users } from './schema';

export const DEMO_PUBLIC_KEY = 'pk_test_demo';
export const DEMO_PASSWORD = 'Password123!';
const DEMO_USERS = [
  { email: 'owner@acme.test', name: 'Olivia Owner', role: 'owner' },
  { email: 'admin@acme.test', name: 'Adam Admin', role: 'admin' },
  { email: 'agent@acme.test', name: 'Aisha Agent', role: 'agent' },
] as const;

const DEMO_TENANT = {
  name: 'Acme Bikes',
  publicKey: DEMO_PUBLIC_KEY,
  allowedDomains: ['localhost', '127.0.0.1'],
  branding: {
    ...DEFAULT_BRANDING,
    primaryColor: '#0f766e',
    greeting: 'Hi! Ask me anything about Acme Bikes: sizing, delivery, returns or warranty.',
  },
};

const SEED_DOCS_DIR = path.resolve(__dirname, '../seed-data/acme-bikes');

/** Title from the first markdown heading, else from the file name. */
function titleOf(markdown: string, file: string): string {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  return heading || file.replace(/\.md$/, '').replace(/[-_]+/g, ' ');
}

/** Store, chunk and embed the demo articles. Skips ones that are already ready. */
async function seedKnowledgeBase(db: Database, tenantId: string): Promise<void> {
  const storage = new LocalFileStorage(resolveStorageDir(process.env, __dirname));
  const embeddings = createEmbeddingProvider(process.env);
  const files = (await readdir(SEED_DOCS_DIR)).filter(
    (f) => f.endsWith('.md') && f !== 'README.md',
  );
  let added = 0;
  for (const file of files.sort()) {
    const markdown = await readFile(path.join(SEED_DOCS_DIR, file), 'utf8');
    let doc = await db.query.documents.findFirst({
      where: and(eq(documents.tenantId, tenantId), eq(documents.source, file)),
    });
    if (doc?.status === 'ready' && doc.chunkCount > 0) continue;
    if (!doc) {
      const id = randomUUID();
      [doc] = await db
        .insert(documents)
        .values({
          id,
          tenantId,
          title: titleOf(markdown, file),
          sourceType: 'text',
          source: file,
          storageKey: `${tenantId}/${id}.md`,
          mimeType: 'text/markdown',
          sizeBytes: Buffer.byteLength(markdown),
          status: 'processing',
        })
        .returning();
    }
    // (Re)write the file so "Re-index" in the dashboard works even after .data was cleared.
    if (doc!.storageKey) await storage.put(doc!.storageKey, Buffer.from(markdown));
    const embedded = await embedDocument(doc!.title, markdown, embeddings);
    await replaceDocumentChunks(db, {
      tenantId,
      documentId: doc!.id,
      embeddingModel: embedded.model,
      chunks: embedded.chunks,
    });
    added += 1;
    console.log(`  knowledge base: ${doc!.title} (${embedded.chunks.length} chunks)`);
  }
  console.log(
    added
      ? `Knowledge base: ${added} article(s) embedded with ${embeddings.model}.`
      : `Knowledge base: ${files.length} articles already ready.`,
  );
}

async function main(): Promise<void> {
  loadDotEnv(__dirname);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  const pool = createPool(url, { max: 1 });
  const db = createDb(pool);
  try {
    let tenant = await db.query.tenants.findFirst({
      where: eq(tenants.publicKey, DEMO_PUBLIC_KEY),
    });
    if (tenant) {
      if (!tenant.onboardingCompletedAt) {
        await db
          .update(tenants)
          .set({
            branding: DEMO_TENANT.branding,
            allowedDomains: DEMO_TENANT.allowedDomains,
            onboardingCompletedAt: new Date(),
          })
          .where(eq(tenants.id, tenant.id));
        console.log('Demo tenant updated with branding, allowed domains and finished onboarding.');
      } else {
        console.log(`Demo tenant already exists (${tenant.name}).`);
      }
    } else {
      [tenant] = await db
        .insert(tenants)
        .values({ ...DEMO_TENANT, onboardingCompletedAt: new Date() })
        .returning();
      console.log('Created demo tenant "Acme Bikes".');
    }

    const passwordHash = await hash(DEMO_PASSWORD);
    for (const user of DEMO_USERS) {
      const existing = await db.query.users.findFirst({ where: eq(users.email, user.email) });
      if (!existing) {
        await db.insert(users).values({ ...user, tenantId: tenant!.id, passwordHash });
        console.log(`  created ${user.role} ${user.email}`);
      }
    }
    console.log(`Demo logins: ${DEMO_USERS.map((u) => u.email).join(', ')} / ${DEMO_PASSWORD}`);
    console.log(`Widget key: ${DEMO_PUBLIC_KEY}`);

    await seedKnowledgeBase(db, tenant!.id);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

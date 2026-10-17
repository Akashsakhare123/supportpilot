// Demo data for local development and the live demo: tenant "Acme Bikes" with one user per role.
// Safe to run repeatedly. T03 adds branding + sample knowledge base docs.
import { hash } from '@node-rs/argon2';
import { loadDotEnv } from '@supportpilot/shared/node';
import { eq } from 'drizzle-orm';
import { createDb, createPool } from './index';
import { tenants, users } from './schema';

export const DEMO_PUBLIC_KEY = 'pk_test_demo';
export const DEMO_PASSWORD = 'Password123!';
const DEMO_USERS = [
  { email: 'owner@acme.test', name: 'Olivia Owner', role: 'owner' },
  { email: 'admin@acme.test', name: 'Adam Admin', role: 'admin' },
  { email: 'agent@acme.test', name: 'Aisha Agent', role: 'agent' },
] as const;

async function main(): Promise<void> {
  loadDotEnv(__dirname);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  const pool = createPool(url, { max: 1 });
  const db = createDb(pool);
  try {
    const existing = await db.query.tenants.findFirst({
      where: eq(tenants.publicKey, DEMO_PUBLIC_KEY),
    });
    if (existing) {
      console.log(`Demo tenant already exists (${existing.name}). Nothing to do.`);
      return;
    }
    const passwordHash = await hash(DEMO_PASSWORD);
    await db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({
          name: 'Acme Bikes',
          publicKey: DEMO_PUBLIC_KEY,
          allowedDomains: ['localhost'],
          branding: { primaryColor: '#3b3f8c', greeting: 'Hi! Ask me anything about Acme Bikes.' },
        })
        .returning();
      await tx
        .insert(users)
        .values(DEMO_USERS.map((u) => ({ ...u, tenantId: tenant!.id, passwordHash })));
    });
    console.log('Seeded demo tenant "Acme Bikes". Log in with any of:');
    for (const u of DEMO_USERS)
      console.log(`  ${u.role.padEnd(6)} ${u.email}  /  ${DEMO_PASSWORD}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

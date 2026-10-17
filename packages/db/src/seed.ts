// Demo data for local development and the live demo: tenant "Acme Bikes" with one user per role.
// Safe to run repeatedly: creates what is missing and keeps the demo tenant's settings current.
// Sample knowledge-base docs live in seed-data/acme-bikes (ingested once T04-T06 exist).
import { hash } from '@node-rs/argon2';
import { DEFAULT_BRANDING } from '@supportpilot/shared';
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
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

// Demo conversation history for the Analytics page (T12): about 30 days of widget chats for
// Acme Bikes with AI answers, ratings, hand-offs and the questions the knowledge base cannot answer.
// Deterministic (seeded random numbers) and idempotent: it replaces only its own "v_demo_" chats.
import { and, eq, like } from 'drizzle-orm';
import type { Database } from './index';
import { conversations, messages } from './schema';

type Failure = 'no_answer' | 'low_confidence';

interface Topic {
  questions: string[];
  /** Relative popularity. */
  weight: number;
  answer: string;
  /** Questions the knowledge base does not cover: how the AI fails on them. */
  failure?: Failure;
}

const NOT_FOUND =
  "I'm sorry, I couldn't find that in our help articles. Would you like me to connect you with a person from our team?";

const TOPICS: Topic[] = [
  {
    weight: 9,
    questions: [
      'How long is the frame warranty?',
      'What does the warranty cover?',
      'Is the frame warranty lifetime?',
      'How do I make a warranty claim?',
    ],
    answer:
      'Frames have a lifetime warranty against manufacturing defects for the original owner; forks, wheels and components are covered for 2 years [1].',
  },
  {
    weight: 8,
    questions: [
      'How long does delivery take?',
      'How long does shipping take?',
      'How much is express delivery?',
      'Do you ship to Canada?',
    ],
    answer:
      'Standard delivery takes 3 to 5 business days and is free over $150; express delivery ($19) takes 1 to 2 business days [1].',
  },
  {
    weight: 7,
    questions: ['Can I return my bike?', 'How do I return a bike?', 'What is your return policy?'],
    answer:
      'You can return any unused bike within 30 days of delivery for a full refund. Start the return from the "My orders" page [1].',
  },
  {
    weight: 6,
    questions: [
      'What size bike do I need?',
      'What bike size for my height?',
      'Which frame size for 180 cm?',
    ],
    answer:
      'Our sizing guide matches frame sizes to your height; at 175-185 cm most riders choose a size L [1].',
  },
  {
    weight: 5,
    questions: [
      'How far can the e-bike go on one charge?',
      'How long does the e-bike battery last?',
      'How long does the e-bike battery take to charge?',
    ],
    answer:
      'The e-bike battery gives 60 to 100 km per charge depending on the assist level, and charges fully in about 4 hours [1].',
  },
  {
    weight: 4,
    questions: ['How do I track my order?', 'Where is my order tracking link?'],
    answer:
      'You get a tracking link by email as soon as your order leaves our warehouse. Weekend orders ship on Monday [1].',
  },
  {
    weight: 2,
    questions: ['My bike arrived damaged, what do I do?', 'The bike arrived damaged'],
    answer:
      'Sorry about that! Send a photo to support within 7 days and we ship a replacement part free of charge [1].',
  },
  // Gaps in the knowledge base: these feed the unanswered-questions report.
  {
    weight: 5,
    failure: 'no_answer',
    questions: [
      'Do you sell skateboards?',
      'Do you have skateboards?',
      'Do you sell electric skateboards?',
    ],
    answer: NOT_FOUND,
  },
  {
    weight: 4,
    failure: 'low_confidence',
    questions: [
      'Can I pay with PayPal?',
      'Can I pay in monthly installments?',
      'Can I pay with crypto?',
    ],
    answer:
      "I'm not completely sure. Our help articles mention refunds to your original payment method, but not which payment methods we accept.",
  },
  {
    weight: 3,
    failure: 'no_answer',
    questions: [
      'Do you have a store in Berlin?',
      'Where is your store?',
      'Can I visit your store?',
    ],
    answer: NOT_FOUND,
  },
  {
    weight: 3,
    failure: 'low_confidence',
    questions: [
      'Do you offer bike servicing?',
      'How often should I service my bike?',
      'Do you service e-bikes?',
    ],
    answer:
      "I'm not sure we offer servicing. Our warranty covers manufacturing defects, but normal wear such as brake pads and chains is not covered.",
  },
  {
    weight: 2,
    failure: 'no_answer',
    questions: ['Do you have a student discount?', 'Is there a discount code?'],
    answer: NOT_FOUND,
  },
];

const AGENT_REPLIES = [
  "Hi, I'm Aisha from Acme Bikes. Happy to help with that!",
  'Thanks for waiting. Let me check that for you.',
  "Good question! We don't have that in our help pages yet, but here's the answer.",
];

/** Small seeded PRNG (mulberry32): the same demo data on every machine. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seedDemoConversations(
  db: Database,
  tenantId: string,
  agentId: string | null,
  now = new Date(),
): Promise<void> {
  await db
    .delete(conversations)
    .where(and(eq(conversations.tenantId, tenantId), like(conversations.visitorId, 'v_demo_%')));

  const rand = random(20261021);
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!;
  const between = (min: number, max: number) => min + rand() * (max - min);
  const totalWeight = TOPICS.reduce((sum, t) => sum + t.weight, 0);
  const pickTopic = () => {
    let r = rand() * totalWeight;
    for (const topic of TOPICS) {
      r -= topic.weight;
      if (r <= 0) return topic;
    }
    return TOPICS[0]!;
  };

  let created = 0;
  let handedOff = 0;
  for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - daysAgo);
    const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
    // Traffic grows a little over the month, with quieter weekends.
    const count = Math.round((4 + (29 - daysAgo) * 0.12) * (weekend ? 0.6 : 1) + rand() * 3);

    for (let c = 0; c < count; c++) {
      let at = day.getTime() + between(8, 21) * 3_600_000;
      if (at > now.getTime() - 3_600_000) continue; // nothing in the future (or the last hour)
      const visitorId = `v_demo_${daysAgo}_${c}_${Math.floor(rand() * 1e6)}`;
      const rows: (typeof messages.$inferInsert)[] = [];
      const add = (row: Omit<typeof messages.$inferInsert, 'conversationId' | 'tenantId'>) =>
        rows.push({ ...row, conversationId: '', tenantId });

      let unsureInARow = 0;
      let handoff: { at: number; reason: 'low_confidence' | 'customer_request' } | null = null;
      const questions = 1 + Math.floor(rand() * rand() * 3);
      for (let q = 0; q < questions && !handoff; q++) {
        const topic = pickTopic();
        add({ sender: 'customer', content: pick(topic.questions), createdAt: new Date(at) });
        const latencyMs = Math.round(between(900, 3200));
        at += latencyMs;
        const failed = topic.failure !== undefined;
        const confidence = failed
          ? topic.failure === 'no_answer'
            ? 0
            : Math.round(between(0.22, 0.44) * 100) / 100
          : Math.round(between(0.62, 0.94) * 100) / 100;
        const roll = rand();
        add({
          sender: 'ai',
          content: topic.answer,
          confidence,
          needsHuman: failed,
          feedback: failed
            ? roll < 0.2
              ? 'down'
              : null
            : roll < 0.38
              ? 'up'
              : roll < 0.44
                ? 'down'
                : null,
          metadata: {
            model: 'mock-extractive-v1',
            latencyMs,
            seeded: true,
            ...(topic.failure === 'no_answer' ? { reason: 'no_relevant_passages' } : {}),
          },
          createdAt: new Date(at),
        });
        unsureInARow = failed ? unsureInARow + 1 : 0;
        at += between(20, 90) * 1000;
        if (unsureInARow >= 2) handoff = { at, reason: 'low_confidence' };
        else if (failed && rand() < 0.35) {
          add({
            sender: 'customer',
            content: 'Can I talk to a person?',
            createdAt: new Date(at),
          });
          at += 800;
          add({
            sender: 'ai',
            content:
              "Of course. I'm connecting you with a person from our team; someone will join this chat shortly.",
            confidence: 0,
            needsHuman: true,
            metadata: { reason: 'customer_asked_for_human', seeded: true },
            createdAt: new Date(at),
          });
          handoff = { at: at + 500, reason: 'customer_request' };
        }
      }

      if (handoff) {
        handedOff += 1;
        add({
          sender: 'system',
          content: 'Waiting for an agent.',
          createdAt: new Date(handoff.at),
        });
        at = handoff.at + between(1, 9) * 60_000;
        add({
          sender: 'system',
          content: 'Aisha Agent joined the conversation',
          createdAt: new Date(at),
        });
        at += 15_000;
        add({
          sender: 'agent',
          userId: agentId,
          content: pick(AGENT_REPLIES),
          createdAt: new Date(at),
        });
      }

      const first = rows[0]!.createdAt as Date;
      const last = rows[rows.length - 1]!.createdAt as Date;
      const [conversation] = await db
        .insert(conversations)
        .values({
          tenantId,
          visitorId,
          status: 'closed',
          origin: 'https://acme-bikes.example',
          assignedAgentId: handoff ? agentId : null,
          handoffReason: handoff?.reason ?? null,
          firstHandoffAt: handoff ? new Date(handoff.at) : null,
          visitorReadAt: last,
          agentReadAt: handoff ? last : null,
          lastMessageAt: last,
          createdAt: first,
          updatedAt: last,
        })
        .returning({ id: conversations.id });
      await db
        .insert(messages)
        .values(rows.map((r) => ({ ...r, conversationId: conversation!.id })));
      created += 1;
    }
  }
  console.log(
    `Demo conversations: ${created} over the last 30 days (${handedOff} handed off), for Analytics.`,
  );
}

/**
 * RAG eval runner (T14): `pnpm eval [--set evals/acme-bikes.json] [--report evals/report.md]
 * [--json evals/report.json] [--min-score 0.8]`.
 *
 * Builds the API's dependency graph (no HTTP server), creates a throwaway tenant on the Business
 * plan, embeds the Acme Bikes seed articles with the configured EMBEDDING_PROVIDER, asks every
 * question through the real ChatService (same retrieval, prompt, model and confidence as
 * customers get) and scores the answers with @supportpilot/ai's eval rules. The tenant is deleted
 * afterwards. Exit code 1 when the score is below --min-score.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  embedDocument,
  type EmbeddingProvider,
  type EvalCaseResult,
  formatReport,
  type LlmProvider,
  scoreCase,
  summarize,
  validateEvalSet,
} from '@supportpilot/ai';
import {
  type Database,
  documents,
  eq,
  replaceDocumentChunks,
  searchChunks,
  tenants,
} from '@supportpilot/db';
import { CHAT_LIMITS, redactPii } from '@supportpilot/shared';
import { findWorkspaceRoot } from '@supportpilot/shared/node';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppModule } from '../app.module';
import { ChatService, EMBEDDING_PROVIDER, LLM_PROVIDER } from '../chat/chat.service';
import { loadEnv } from '../config/env';
import { DRIZZLE } from '../database/database.module';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const root = findWorkspaceRoot(__dirname);
  loadEnv();
  const setFile = path.resolve(root, arg('set') ?? 'evals/acme-bikes.json');
  const reportFile = path.resolve(root, arg('report') ?? 'evals/report.md');
  const jsonFile = path.resolve(root, arg('json') ?? reportFile.replace(/\.md$/, '.json'));
  const minScoreArg = arg('min-score') ?? process.env.EVAL_MIN_SCORE;
  const minScore = minScoreArg ? Number(minScoreArg) : undefined;
  const set = validateEvalSet(JSON.parse(await readFile(setFile, 'utf8')));
  const docsDir = path.join(root, 'packages/db/seed-data/acme-bikes');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const db = app.get<Database>(DRIZZLE);
  const chat = app.get(ChatService);
  const embeddings = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
  const llm = app.get<LlmProvider>(LLM_PROVIDER);
  console.log(
    `Eval "${set.name}": ${set.cases.length} cases, LLM ${llm.model}, embeddings ${embeddings.model}`,
  );

  const [tenant] = await db
    .insert(tenants)
    .values({
      name: 'Acme Bikes',
      plan: 'business',
      publicKey: `pk_test_eval_${randomUUID().slice(0, 12)}`,
    })
    .returning();
  try {
    for (const file of (await readdir(docsDir)).filter(
      (f) => f.endsWith('.md') && f !== 'README.md',
    )) {
      const markdown = await readFile(path.join(docsDir, file), 'utf8');
      const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? file;
      const [doc] = await db
        .insert(documents)
        .values({
          tenantId: tenant!.id,
          title,
          sourceType: 'text',
          source: file,
          status: 'processing',
        })
        .returning();
      const embedded = await embedDocument(title, markdown, embeddings);
      await replaceDocumentChunks(db, {
        tenantId: tenant!.id,
        documentId: doc!.id,
        embeddingModel: embedded.model,
        chunks: embedded.chunks,
      });
    }

    const results: EvalCaseResult[] = [];
    for (const testCase of set.cases) {
      // A new playground conversation per question: no memory, no inbox, no hand-off side effects.
      const conversation = await chat.openConversation({
        tenant: tenant!,
        visitorId: 'playground:eval',
        message: testCase.question,
      });
      const started = Date.now();
      const done = await chat.respond(tenant!, conversation, testCase.question, {
        meta: () => undefined,
        delta: () => undefined,
      });
      const latencyMs = Date.now() - started;
      const [vector] = await embeddings.embed([redactPii(testCase.question).text]);
      const hits = await searchChunks(db, {
        tenantId: tenant!.id,
        embedding: vector!,
        embeddingModel: embeddings.model,
        limit: CHAT_LIMITS.topK,
      });
      const result = scoreCase(testCase, {
        content: done.content,
        needsHuman: done.needsHuman,
        retrievedTitles: [...new Set(hits.map((h) => h.documentTitle))],
        citedTitles: [...new Set(done.sources.map((s) => s.documentTitle))],
        confidence: done.confidence,
        latencyMs,
      });
      results.push(result);
      console.log(
        `  ${result.passed ? 'PASS' : 'FAIL'} ${testCase.id} ${result.failures.join('; ')}`,
      );
    }

    const summary = summarize(results);
    const report = formatReport(summary, results, {
      set: set.name,
      llmModel: llm.model,
      embeddingModel: embeddings.model,
      topK: CHAT_LIMITS.topK,
      date: new Date().toISOString().slice(0, 10),
      minScore,
    });
    await mkdir(path.dirname(reportFile), { recursive: true });
    await writeFile(reportFile, report);
    await writeFile(
      jsonFile,
      `${JSON.stringify({ llmModel: llm.model, embeddingModel: embeddings.model, summary, results }, null, 2)}\n`,
    );
    console.log(`\n${report}`);
    console.log(`Report: ${path.relative(root, reportFile)}, ${path.relative(root, jsonFile)}`);
    return minScore !== undefined && summary.score < minScore ? 1 : 0;
  } finally {
    await db.delete(tenants).where(eq(tenants.id, tenant!.id));
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);

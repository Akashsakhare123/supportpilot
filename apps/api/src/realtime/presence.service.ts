import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { asc, type Database, eq, users } from '@supportpilot/db';
import {
  type AgentPresence,
  combinePresence,
  PRESENCE,
  type PresenceState,
} from '@supportpilot/shared';
import type { Redis } from 'ioredis';
import { DRIZZLE } from '../database/database.module';
import { REDIS } from '../redis/redis.module';
import { RealtimeService } from './realtime.service';

const STATE_ORDER: Record<PresenceState, number> = { online: 0, away: 1, offline: 2 };

export const presenceKeys = {
  /** One key per open dashboard tab, value online | away, expires without heartbeats. */
  tab: (tenantId: string, userId: string, tabId: string) =>
    `presence:${tenantId}:tab:${userId}:${tabId}`,
  /** Index of a tenant's tabs (members "userId:tabId"); entries whose key expired are pruned. */
  tabs: (tenantId: string) => `presence:${tenantId}:tabs`,
  /** Last announced snapshot, so a change is announced exactly once across API instances. */
  last: (tenantId: string) => `presence:${tenantId}:last`,
  /** Tenants with live tabs, for the expiry sweep. */
  tenants: 'presence:tenants',
};

/**
 * Agent presence in Redis. Each dashboard tab writes its state to a key with a 30 s TTL and
 * refreshes it every 10 s; a closed tab deletes its key, a crashed one simply expires. Every API
 * instance sweeps every few seconds, and the first one to see a change announces it to
 * dashboards (presence:update) and, when "anyone online" flips, to widgets.
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), PRESENCE.sweepMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Heartbeat or state change of one tab. Announces only when the tab's state actually changed
   * (new tab, away <-> online, or the key had expired), so steady heartbeats cost two Redis calls.
   */
  async beat(
    tenantId: string,
    userId: string,
    tabId: string,
    state: Exclude<PresenceState, 'offline'>,
  ): Promise<void> {
    const key = presenceKeys.tab(tenantId, userId, tabId);
    const [[, previous]] = (await this.redis
      .multi()
      .call('SET', key, state, 'EX', String(PRESENCE.ttlSeconds), 'GET')
      .sadd(presenceKeys.tabs(tenantId), `${userId}:${tabId}`)
      .sadd(presenceKeys.tenants, tenantId)
      .exec()) as [[Error | null, string | null], ...unknown[]];
    if (previous !== state) await this.announce(tenantId);
  }

  /** The tab closed cleanly (socket disconnect): offline at once, no need to wait for the TTL. */
  async leave(tenantId: string, userId: string, tabId: string): Promise<void> {
    await this.redis
      .multi()
      .del(presenceKeys.tab(tenantId, userId, tabId))
      .srem(presenceKeys.tabs(tenantId), `${userId}:${tabId}`)
      .exec();
    await this.announce(tenantId);
  }

  /** State per user from their live tabs (expired tabs are pruned from the index). */
  private async liveStates(tenantId: string): Promise<Map<string, PresenceState>> {
    const members = await this.redis.smembers(presenceKeys.tabs(tenantId));
    const byUser = new Map<string, PresenceState[]>();
    if (members.length === 0) return new Map();
    const values = await this.redis.mget(
      members.map((m) => {
        const [userId, tabId] = m.split(':') as [string, string];
        return presenceKeys.tab(tenantId, userId, tabId);
      }),
    );
    const expired: string[] = [];
    members.forEach((member, i) => {
      const value = values[i];
      const userId = member.split(':')[0]!;
      if (value === 'online' || value === 'away') {
        byUser.set(userId, [...(byUser.get(userId) ?? []), value]);
      } else expired.push(member);
    });
    if (expired.length) await this.redis.srem(presenceKeys.tabs(tenantId), ...expired);
    return new Map([...byUser].map(([userId, states]) => [userId, combinePresence(states)]));
  }

  /** Number of team members who are online (away does not count: they cannot answer now). */
  async onlineCount(tenantId: string): Promise<number> {
    try {
      const states = await this.liveStates(tenantId);
      return [...states.values()].filter((s) => s === 'online').length;
    } catch (error) {
      this.logger.warn(`Could not read presence: ${(error as Error).message}`);
      return 0;
    }
  }

  /** Every team member with their state: online first, then away, then offline, by name. */
  async snapshot(tenantId: string): Promise<AgentPresence[]> {
    const [states, team] = await Promise.all([
      this.liveStates(tenantId),
      this.db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.tenantId, tenantId))
        .orderBy(asc(users.name)),
    ]);
    return team
      .map((u) => ({ userId: u.id, name: u.name, state: states.get(u.id) ?? 'offline' }))
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
  }

  /**
   * Announce the tenant's presence if it differs from the last announcement. SET ... GET swaps
   * the stored signature atomically, so when several instances notice the same change only the
   * first one emits.
   */
  async announce(tenantId: string): Promise<void> {
    try {
      const agents = await this.snapshot(tenantId);
      const signature = agents
        .filter((a) => a.state !== 'offline')
        .map((a) => `${a.userId}=${a.state}`)
        .join(',');
      const previous = (await this.redis.call(
        'SET',
        presenceKeys.last(tenantId),
        signature,
        'EX',
        '86400',
        'GET',
      )) as string | null;
      if ((previous ?? '') === signature) return;
      this.realtime.presenceChanged(tenantId, agents);
      const wasOnline = (previous ?? '').includes('=online');
      const isOnline = signature.includes('=online');
      if (wasOnline !== isOnline) this.realtime.widgetPresence(tenantId, isOnline);
    } catch (error) {
      this.logger.warn(`Could not announce presence: ${(error as Error).message}`);
    }
  }

  /** Find tabs whose heartbeats stopped (crashed browser, lost network) and announce them. */
  async sweep(): Promise<void> {
    try {
      const tenants = await this.redis.smembers(presenceKeys.tenants);
      for (const tenantId of tenants) {
        await this.announce(tenantId);
        if ((await this.redis.scard(presenceKeys.tabs(tenantId))) === 0) {
          await this.redis.srem(presenceKeys.tenants, tenantId);
        }
      }
    } catch (error) {
      this.logger.warn(`Presence sweep failed: ${(error as Error).message}`);
    }
  }
}

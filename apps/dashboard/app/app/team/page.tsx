'use client';

import {
  type InviteCreated,
  invitableRoles,
  roleAtLeast,
  type TeamMember,
} from '@supportpilot/shared';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { readError, useAuth } from '@/lib/auth';

export default function TeamPage() {
  const { user, apiFetch } = useAuth();
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [created, setCreated] = useState<InviteCreated | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch('/users');
    if (res.ok) setMembers((await res.json()) as TeamMember[]);
    else setError(await readError(res));
  }, [apiFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!user) return null;
  if (!roleAtLeast(user.role, 'admin')) {
    return <Alert>Only admins and owners can manage the team.</Alert>;
  }
  const roles = invitableRoles(user.role);

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    setPending(true);
    setInviteError(null);
    setCreated(null);
    try {
      const res = await apiFetch('/users/invites', {
        method: 'POST',
        body: JSON.stringify({ email: form.get('email'), role: form.get('role') }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setCreated((await res.json()) as InviteCreated);
      formEl.reset();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Could not create the invite');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Team</h1>

      <Card>
        <CardTitle>Invite a teammate</CardTitle>
        <CardDescription>
          {user.role === 'owner'
            ? 'Owners can invite admins and agents.'
            : 'Admins can invite agents.'}
        </CardDescription>
        <form onSubmit={onInvite} className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-60 flex-1 space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input id="invite-email" name="email" type="email" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <select
              id="invite-role"
              name="role"
              defaultValue="agent"
              className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm"
            >
              {roles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Sending...' : 'Create invite'}
          </Button>
        </form>
        {inviteError && <Alert className="mt-4">{inviteError}</Alert>}
        {created && (
          <Alert tone="success" className="mt-4 space-y-1">
            <p>
              Invite created for <strong>{created.email}</strong> ({created.role}), valid for 7
              days.
            </p>
            {created.inviteUrl && (
              <p className="break-all">
                Dev mode, no email is sent. Share this link: <code>{created.inviteUrl}</code>
              </p>
            )}
          </Alert>
        )}
      </Card>

      <Card className="p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase">
            <tr>
              <th className="px-6 py-3 font-medium">Name</th>
              <th className="px-6 py-3 font-medium">Email</th>
              <th className="px-6 py-3 font-medium">Role</th>
              <th className="px-6 py-3 font-medium">Last login</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {members?.map((m) => (
              <tr key={m.id}>
                <td className="px-6 py-3 font-medium">{m.name}</td>
                <td className="px-6 py-3 text-slate-600">{m.email}</td>
                <td className="px-6 py-3 capitalize">{m.role}</td>
                <td className="px-6 py-3 text-slate-500">
                  {m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString() : 'Never'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!members && !error && <p className="px-6 py-4 text-sm text-slate-500">Loading...</p>}
        {error && <Alert className="m-4">{error}</Alert>}
      </Card>
    </div>
  );
}

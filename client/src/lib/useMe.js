import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';

/**
 * Who is logged in and what they may do. The owner (env password) can do
 * everything; admins carry a permission map + project scope. The server
 * enforces every route — this only drives what the UI shows.
 */
export function useMe() {
  const { data } = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 60_000 });
  return data?.me || null;
}

/** True when the identity is loaded AND allowed. Conservative while loading. */
export const can = (me, perm) => Boolean(me && (me.role === 'owner' || me.permissions?.[perm]));

export const isOwner = (me) => me?.role === 'owner';

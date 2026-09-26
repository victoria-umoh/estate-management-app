'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api/client';

/**
 * The signed-in resident's own profile.
 *
 * Screens used to read `membershipId` from `localStorage`, which never worked:
 * nothing ever wrote it, so every feature depending on it silently did nothing.
 * The id now comes from the session over `/me/profile`, which also means it
 * cannot be edited in dev tools to act as somebody else.
 */
export interface Profile {
  membershipId: string;
  estateName: string | null;
  residentCode: string | null;
  category: string;
  status: string;
  fullName: string;
  email: string;
  phone: string | null;
  identityProvided: boolean;
  ninLast4: string | null;
  property: {
    id: string;
    unitNumber: string;
    block: string | null;
    street: string;
    type: string;
  } | null;
  movedInAt: string | null;
}

export function useProfile(): { profile: Profile | null; loading: boolean; failed: boolean } {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    api
      .get<Profile>('/me/profile')
      .then((result) => {
        if (!cancelled) setProfile(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { profile, loading, failed };
}

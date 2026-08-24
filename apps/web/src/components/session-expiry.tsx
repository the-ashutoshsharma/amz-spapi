'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { LogIn } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  probeSession,
  sessionExpired,
  signInUrl,
  subscribeToSessionExpiry,
  watchFetchForSignOut,
} from '@/lib/session-expiry';

const getSnapshot = () => sessionExpired();
// The server always renders a live session — it would have redirected
// otherwise — so the first client render must agree or React reports a
// hydration mismatch on a page that is perfectly fine.
const getServerSnapshot = () => false;

/** Whether the login session has been found to be gone. */
export function useSessionExpired(): boolean {
  return useSyncExternalStore(
    subscribeToSessionExpiry,
    getSnapshot,
    getServerSnapshot
  );
}

/**
 * A tab hidden longer than this is asked about before it is trusted.
 *
 * Long enough that flicking to another tab and back costs nothing, short
 * enough that a lunch break is covered.
 */
const AWAY_MS = 60_000;

function goToSignIn(): void {
  window.location.href = signInUrl(window.location);
}

/**
 * Watches for the login session ending and says so.
 *
 * Mounted once, in the signed-in layout. Two ways in: any same-origin 401 (the
 * common one — the seller clicked something and it failed), and a check when a
 * parked tab comes back to the foreground (the one nothing else can see,
 * because a session that dies with no requests in flight leaves no trace).
 *
 * The dialog can be dismissed. Being told you are signed out and then trapped
 * behind a modal is worse than the bug: somebody may want to copy an answer
 * out of the page before the round trip to Auth0 discards what is only in
 * memory. Dismissing leaves the bar below, which does not go away.
 */
export function SessionExpiryWatcher() {
  const expired = useSessionExpired();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const stopWatchingFetch = watchFetchForSignOut(window);

    let hiddenAt = 0;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      if (away > AWAY_MS) void probeSession(window);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopWatchingFetch();
    };
  }, []);

  if (!expired) return null;

  if (dismissed) {
    /**
     * Top-centre and compact, not a bar across the bottom: chat pins itself to
     * the viewport and puts the composer at the very bottom, so a full-width
     * bar there would sit on top of the send button — a notice that breaks the
     * page it is warning about.
     */
    return (
      <div
        role="status"
        className="fixed left-1/2 top-16 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-destructive/30 bg-background/95 py-1.5 pl-4 pr-1.5 shadow-lg backdrop-blur"
      >
        <p className="text-sm text-foreground">
          Signed out — nothing here will save.
        </p>
        <Button size="sm" className="rounded-full" onClick={goToSignIn}>
          <LogIn className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <AlertDialog open>
      <AlertDialogContent onEscapeKeyDown={(event) => event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Your session has expired</AlertDialogTitle>
          <AlertDialogDescription>
            You have been signed out, so anything you do here now will fail.
            Sign in again and you will come back to this page — a conversation
            picks up where it left off, and what you were typing is kept.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setDismissed(true)}>
            Not now
          </AlertDialogCancel>
          <AlertDialogAction onClick={goToSignIn}>
            Sign in again
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

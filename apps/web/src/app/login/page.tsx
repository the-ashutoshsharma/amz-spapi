import { auth0 } from '@/lib/auth0';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { safeReturnTo } from '@/lib/signed-out';

/**
 * The sign-in page, which is also the landing spot for anyone the app has just
 * turned away.
 *
 * `returnTo` is carried through to Auth0 instead of the hardcoded `/chat` this
 * used to send everyone to. A seller whose session expired on the shipments
 * page was signed back in and dropped into chat, which looks like the app
 * losing their place — and is, since nothing else remembers where they were.
 */
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const session = await auth0.getSession();
  const { returnTo } = await searchParams;
  const destination = safeReturnTo(returnTo);

  if (session) {
    redirect(destination);
  }

  // A `returnTo` means something inside the app sent them here, which only
  // happens when a session was expected and was not there.
  const wasSignedOut = Boolean(returnTo);
  const loginHref = `/auth/login?returnTo=${encodeURIComponent(destination)}`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary">
            <span className="text-lg font-bold text-primary-foreground">S</span>
          </div>
          <CardTitle className="text-2xl">
            {wasSignedOut ? 'Your session has ended' : 'Sign in to Sellavant'}
          </CardTitle>
          <CardDescription>
            {wasSignedOut
              ? 'Sign in again and you will come back to the page you were on.'
              : 'Access your Amazon seller dashboard and AI assistant'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button className="w-full" size="lg" asChild>
            <a href={loginHref}>Continue with Auth0</a>
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Don&apos;t have an account?{' '}
            <a
              href={`/auth/login?screen_hint=signup&returnTo=${encodeURIComponent(
                destination
              )}`}
              className="underline hover:text-foreground"
            >
              Sign up
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

import { SignIn } from '@clerk/nextjs';
import { AuthScreen, clerkAppearance } from '@/components/AuthScreen';

export default function SignInPage() {
  return (
    <AuthScreen>
      <SignIn appearance={clerkAppearance} />
    </AuthScreen>
  );
}

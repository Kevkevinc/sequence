import { SignUp } from '@clerk/nextjs';
import { AuthScreen, clerkAppearance } from '@/components/AuthScreen';

export default function SignUpPage() {
  return (
    <AuthScreen>
      <SignUp appearance={clerkAppearance} />
    </AuthScreen>
  );
}

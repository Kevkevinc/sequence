import Link from "next/link";
import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";

export default function Home() {
  return (
    <main style={{ padding: "2rem", maxWidth: "40rem", margin: "0 auto" }}>
      <h1>UGC AI Editor</h1>
      <p>Upload your raw clips, set your video options, and create UGC videos.</p>

      <Show when="signed-out">
        <p>Sign in to get started.</p>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <SignInButton>
            <button>Sign in</button>
          </SignInButton>
          <SignUpButton>
            <button>Sign up</button>
          </SignUpButton>
        </div>
      </Show>

      <Show when="signed-in">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <UserButton />
          <span>You are signed in.</span>
        </div>
        <nav>
          <ul>
            <li>
              <Link href="/jobs">Your videos</Link>
            </li>
            <li>
              <Link href="/jobs/new">Create a new video</Link>
            </li>
            <li>
              <Link href="/profile">Your profile</Link>
            </li>
          </ul>
        </nav>
      </Show>
    </main>
  );
}

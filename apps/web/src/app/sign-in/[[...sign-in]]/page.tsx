import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <SignIn
        afterSignInUrl="/dashboard"
        appearance={{
          variables: { colorPrimary: "#6366f1", colorBackground: "#111827", colorText: "#f9fafb", colorInputBackground: "#1f2937", colorInputText: "#f9fafb" },
        }}
      />
    </div>
  );
}

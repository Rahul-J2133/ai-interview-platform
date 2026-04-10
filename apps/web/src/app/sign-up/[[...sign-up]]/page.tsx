import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <SignUp
        afterSignUpUrl="/dashboard"
        appearance={{
          variables: { colorPrimary: "#6366f1", colorBackground: "#111827", colorText: "#f9fafb", colorInputBackground: "#1f2937", colorInputText: "#f9fafb" },
        }}
      />
    </div>
  );
}

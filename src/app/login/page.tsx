import { redirect } from "next/navigation";
import Image from "next/image";
import { isAuthenticated } from "@/lib/auth";
import { LoginForm } from "@/components/LoginForm";

export default async function LoginPage() {
  if (await isAuthenticated()) redirect("/dashboard");
  return (
    <main className="login-shell min-h-screen flex items-center justify-center px-4 py-10">
      <div className="login-card w-full max-w-md p-8">
        <div className="flex items-center gap-3 mb-6">
          <Image
            src="/avatar.jpg"
            alt="logo"
            width={40}
            height={40}
            className="w-10 h-10 shrink-0 rounded-full object-cover ring-2 ring-amber-200/90 shadow-md"
          />
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Asset Dashboard</h1>
            <p className="text-sm text-slate-500">请输入密码</p>
          </div>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}

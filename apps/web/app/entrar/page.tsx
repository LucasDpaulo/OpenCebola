import type { Metadata } from "next";
import { LoginExperience } from "./login-experience";

export const metadata: Metadata = {
  title: "Entrar · OpenCebola",
  description: "Acesse sua conta no Cebola."
};

export default function LoginPage() {
  return <LoginExperience />;
}



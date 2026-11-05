import { Suspense } from "react";
import { TitleExperience } from "./title-experience";

export default function TitlePage() {
  return <Suspense fallback={<main className="home-state">Carregando título…</main>}><TitleExperience /></Suspense>;
}

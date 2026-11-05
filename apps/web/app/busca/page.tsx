import { Suspense } from "react";
import { SearchExperience } from "./search-experience";

export default function SearchPage() {
  return (
    <Suspense fallback={<main className="home-state">Carregando busca…</main>}>
      <SearchExperience />
    </Suspense>
  );
}

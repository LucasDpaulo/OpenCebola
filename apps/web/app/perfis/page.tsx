import { Suspense } from "react";
import type { Metadata } from "next";
import { BrandIcon } from "../brand-icon";
import { ProfilePicker } from "./profile-picker";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Quem está assistindo?",
  description: "Escolha quem está assistindo."
};

export default function ProfilesPage() {
  return (
    <main className={styles.page} id="profiles-page-root">
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="Início">
          <BrandIcon size={36} className={styles.brandIcon} />
        </a>
      </header>

      <section className={styles.content} aria-labelledby="profiles-title">
        <div className={styles.heading}>
          <h1 id="profiles-title">Quem está assistindo?</h1>
        </div>

        <Suspense fallback={
          <div className={styles.statePanel} role="status">
            <span className={styles.stateSpinner} aria-hidden="true" />
            <strong>Carregando perfis…</strong>
          </div>
        }>
          <ProfilePicker />
        </Suspense>
      </section>
    </main>
  );
}

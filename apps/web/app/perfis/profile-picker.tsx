"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "./page.module.css";
import { apiFetch } from "../api-client";
import { AVATAR_PRESETS, formatPresetKey } from "./avatar-catalog";
import { ProfileAvatar } from "./profile-avatar";

export type Profile = {
  id: string;
  name: string;
  avatarUrl: string | null;
  hasPin: boolean;
};

type ProfilesResponse = readonly Profile[] | { profiles: readonly Profile[] };
type ViewState = "loading" | "ready" | "unauthorized" | "error";
type Tone = "blue" | "green" | "violet" | "coral" | "amber" | "rose" | "cyan" | "emerald";

const tones: readonly Tone[] = ["blue", "green", "violet", "coral", "amber", "rose", "cyan", "emerald"];

const toneClassMap: Record<Tone, string> = {
  blue: styles.toneBlue,
  green: styles.toneGreen,
  violet: styles.toneViolet,
  coral: styles.toneCoral,
  amber: styles.toneAmber,
  rose: styles.toneRose,
  cyan: styles.toneCyan,
  emerald: styles.toneEmerald
};

function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
    </svg>
  );
}

function PencilIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function TrashIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function isProfile(value: unknown): value is Profile {
  if (typeof value !== "object" || value === null) return false;
  const profile = value as Partial<Profile>;
  return (
    typeof profile.id === "string" &&
    typeof profile.name === "string" &&
    (typeof profile.avatarUrl === "string" || profile.avatarUrl === null) &&
    typeof profile.hasPin === "boolean"
  );
}

function parseProfiles(value: unknown): readonly Profile[] | null {
  const response = value as Partial<{ profiles: unknown }>;
  const candidate = Array.isArray(value) ? value : response?.profiles;
  return Array.isArray(candidate) && candidate.every(isProfile) ? candidate : null;
}

export function ProfilePicker() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editProfileId = searchParams.get("edit");
  const manageParam = searchParams.get("manage");

  const gridRef = useRef<HTMLDivElement>(null);
  const modalTriggerRef = useRef<HTMLElement | null>(null);

  const [viewState, setViewState] = useState<ViewState>("loading");
  const [profiles, setProfiles] = useState<readonly Profile[]>([]);
  const [isManaging, setIsManaging] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  // Activate / PIN Login State
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);
  const [pinMessage, setPinMessage] = useState("");
  const [activatingId, setActivatingId] = useState<string | null>(null);

  // Create Profile State
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createAvatar, setCreateAvatar] = useState<string | null>(null);
  const [createWithPin, setCreateWithPin] = useState(false);
  const [createPin, setCreatePin] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState("");

  // Edit Profile State
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [editName, setEditName] = useState("");
  const [editAvatar, setEditAvatar] = useState<string | null>(null);
  const [editPinOpen, setEditPinOpen] = useState(false);
  const [editPinAction, setEditPinAction] = useState<"keep" | "change" | "remove">("keep");
  const [editPin, setEditPin] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [editMessage, setEditMessage] = useState("");

  // Delete Confirmation State
  const [deleteConfirmProfile, setDeleteConfirmProfile] = useState<Profile | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState("");

  const loadProfiles = useCallback(async (signal?: AbortSignal) => {
    setViewState("loading");

    try {
      const response = await apiFetch(`/v1/profiles`, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal
      });

      if (response.status === 401) {
        setProfiles([]);
        setViewState("unauthorized");
        return;
      }

      if (!response.ok) {
        setViewState("error");
        return;
      }

      const body = (await response.json()) as ProfilesResponse;
      const parsed = parseProfiles(body);
      if (parsed === null || parsed.length > 8) {
        setViewState("error");
        return;
      }

      setProfiles(parsed);
      setViewState("ready");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setViewState("error");
      }
    }
  }, []);

  function rememberModalTrigger() {
    modalTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  function restoreModalTrigger() {
    const trigger = modalTriggerRef.current;
    modalTriggerRef.current = null;
    requestAnimationFrame(() => trigger?.focus());
  }

  function closePinDialog() {
    if (activatingId !== null) return;
    setSelectedProfile(null);
    setPinMessage("");
    restoreModalTrigger();
  }

  function openCreateDialog() {
    rememberModalTrigger();
    setCreateName("");
    setCreateAvatar(null);
    setCreateWithPin(false);
    setCreatePin("");
    setCreateMessage("");
    setIsCreateOpen(true);
  }

  function closeCreateDialog() {
    if (isCreating) return;
    setIsCreateOpen(false);
    setCreateMessage("");
    restoreModalTrigger();
  }

  function openEditDialog(profile: Profile) {
    rememberModalTrigger();
    setEditingProfile(profile);
    setEditName(profile.name);
    setEditAvatar(profile.avatarUrl);
    setEditPinOpen(false);
    setEditPinAction("keep");
    setEditPin("");
    setEditMessage("");
  }

  function closeEditDialog() {
    if (isSaving) return;
    setEditingProfile(null);
    setEditMessage("");
    restoreModalTrigger();
  }

  function openDeleteConfirm(profile: Profile) {
    setDeleteConfirmProfile(profile);
    setDeleteMessage("");
  }

  function closeDeleteConfirm() {
    if (isDeleting) return;
    setDeleteConfirmProfile(null);
    setDeleteMessage("");
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadProfiles(controller.signal);
    return () => controller.abort();
  }, [loadProfiles]);

  useEffect(() => {
    if (manageParam === "true") {
      setIsManaging(true);
    }
  }, [manageParam]);

  useEffect(() => {
    if (editProfileId && profiles.length > 0) {
      const found = profiles.find((p) => p.id === editProfileId);
      if (found) {
        openEditDialog(found);
      }
    }
  }, [editProfileId, profiles]);

  async function activateProfile(profile: Profile, pin?: string) {
    setActivatingId(profile.id);
    setPinMessage("");

    try {
      const response = await apiFetch(`/v1/profiles/${encodeURIComponent(profile.id)}/activate`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pin === undefined ? {} : { pin })
      });

      if (response.status === 401) {
        setSelectedProfile(null);
        setActivatingId(null);
        setViewState("unauthorized");
        return;
      }

      if (!response.ok) {
        setActivatingId(null);
        if (profile.hasPin) {
          setPinMessage("Não foi possível abrir o perfil. Confira o PIN e tente novamente.");
        } else {
          setViewState("error");
        }
        return;
      }

      // Smooth fade-out transition
      setIsExiting(true);
      const root = document.getElementById("profiles-page-root");
      if (root) root.classList.add(styles.pageExiting);

      setTimeout(() => {
        setSelectedProfile(null);
        router.replace("/");
      }, 350);
    } catch {
      setActivatingId(null);
      if (profile.hasPin) {
        setPinMessage("Não foi possível abrir o perfil. Confira o PIN e tente novamente.");
      } else {
        setViewState("error");
      }
    }
  }

  function handleProfileClick(profile: Profile) {
    if (isManaging) {
      openEditDialog(profile);
      return;
    }

    if (profile.hasPin) {
      rememberModalTrigger();
      setSelectedProfile(profile);
      setPinMessage("");
      return;
    }

    void activateProfile(profile);
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = createName.trim();
    if (!name) {
      setCreateMessage("Por favor, digite um nome para o perfil.");
      return;
    }

    if (createWithPin && (!createPin || !/^\d{4}$/.test(createPin))) {
      setCreateMessage("O PIN deve conter exatamente 4 dígitos numéricos.");
      return;
    }

    setIsCreating(true);
    setCreateMessage("");

    try {
      const bodyPayload: { name: string; avatarUrl?: string | null; pin?: string } = {
        name,
        avatarUrl: createAvatar || null
      };

      if (createWithPin && createPin) {
        bodyPayload.pin = createPin;
      }

      const response = await apiFetch(`/v1/profiles`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload)
      });

      if (response.status === 401) {
        setIsCreateOpen(false);
        setViewState("unauthorized");
        return;
      }

      if (!response.ok) {
        setCreateMessage("Não foi possível criar o perfil. Confira os dados e tente novamente.");
        return;
      }

      setIsCreateOpen(false);
      await loadProfiles();
      restoreModalTrigger();
    } catch {
      setCreateMessage("Não foi possível criar o perfil. Confira a conexão e tente novamente.");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingProfile) return;

    const name = editName.trim();
    if (!name) {
      setEditMessage("Por favor, informe um nome válido para o perfil.");
      return;
    }

    if (editPinAction === "change" && (!editPin || !/^\d{4}$/.test(editPin))) {
      setEditMessage("O PIN deve conter exatamente 4 dígitos numéricos.");
      return;
    }

    setIsSaving(true);
    setEditMessage("");

    try {
      const payload: { name: string; avatarUrl: string | null; pin?: string | null } = {
        name,
        avatarUrl: editAvatar || null
      };

      if (editPinAction === "change") {
        payload.pin = editPin;
      } else if (editPinAction === "remove") {
        payload.pin = null;
      }

      const response = await apiFetch(`/v1/profiles/${encodeURIComponent(editingProfile.id)}`, {
        method: "PATCH",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (response.status === 401) {
        setEditingProfile(null);
        setViewState("unauthorized");
        return;
      }

      if (!response.ok) {
        setEditMessage("Não foi possível atualizar o perfil. Tente novamente.");
        return;
      }

      setEditingProfile(null);
      await loadProfiles();
      restoreModalTrigger();
    } catch {
      setEditMessage("Não foi possível salvar as alterações. Verifique sua conexão.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeleteProfile(profileId: string) {
    setIsDeleting(true);
    setDeleteMessage("");

    try {
      const response = await apiFetch(`/v1/profiles/${encodeURIComponent(profileId)}`, {
        method: "DELETE",
        cache: "no-store"
      });

      if (response.status === 401) {
        setDeleteConfirmProfile(null);
        setEditingProfile(null);
        setViewState("unauthorized");
        return;
      }

      if (!response.ok) {
        setDeleteMessage("Não foi possível excluir o perfil. Tente novamente.");
        return;
      }

      setDeleteConfirmProfile(null);
      setEditingProfile(null);
      await loadProfiles();
      restoreModalTrigger();
    } catch {
      setDeleteMessage("Falha ao excluir perfil. Verifique a conexão.");
    } finally {
      setIsDeleting(false);
    }
  }

  function handleModalKeyDown(event: KeyboardEvent<HTMLElement>, close: () => void) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  function handleGridNavigation(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;

    const buttons = Array.from(
      gridRef.current?.querySelectorAll<HTMLButtonElement>("[data-profile-card]") ?? []
    );
    const active = document.activeElement as HTMLButtonElement;
    const currentIndex = buttons.indexOf(active);
    if (currentIndex < 0) return;

    const currentRect = active.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    const candidates = buttons
      .map((button, index) => {
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const directionMatches =
          (event.key === "ArrowLeft" && x < currentX) ||
          (event.key === "ArrowRight" && x > currentX) ||
          (event.key === "ArrowUp" && y < currentY) ||
          (event.key === "ArrowDown" && y > currentY);

        return {
          button,
          index,
          directionMatches,
          distance: Math.hypot(x - currentX, y - currentY)
        };
      })
      .filter((candidate) => candidate.directionMatches)
      .sort((a, b) => a.distance - b.distance || a.index - b.index);

    if (candidates[0]) {
      event.preventDefault();
      candidates[0].button.focus();
    }
  }

  function handlePinSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!selectedProfile) return;

    if (!form.checkValidity()) {
      form.reportValidity();
      setPinMessage("Não foi possível abrir o perfil. Confira o PIN e tente novamente.");
      return;
    }

    const data = new FormData(form);
    const pin = String(data.get("pin") ?? "");
    form.reset();
    void activateProfile(selectedProfile, pin);
  }

  if (viewState === "loading") {
    return (
      <div className={styles.statePanel} role="status" aria-live="polite">
        <span className={styles.stateSpinner} aria-hidden="true" />
        <strong>Carregando perfis…</strong>
        <p>Buscando os perfis protegidos da sua casa.</p>
      </div>
    );
  }

  if (viewState === "unauthorized") {
    return (
      <div className={styles.statePanel} role="alert">
        <span className={styles.stateIcon} aria-hidden="true">↗</span>
        <strong>Sua sessão terminou.</strong>
        <p>Entre novamente para acessar os perfis desta casa.</p>
        <a className={styles.stateAction} href="/entrar">Voltar para o acesso</a>
      </div>
    );
  }

  if (viewState === "error") {
    return (
      <div className={styles.statePanel} role="alert">
        <span className={styles.stateIcon} aria-hidden="true">!</span>
        <strong>Não foi possível carregar os perfis.</strong>
        <p>Confira a conexão e tente novamente em instantes.</p>
        <button className={styles.stateAction} type="button" onClick={() => void loadProfiles()}>
          Tentar novamente
        </button>
      </div>
    );
  }

  return (
    <>
      {profiles.length === 0 ? (
        <div className={styles.statePanel} role="status">
          <span className={styles.stateIcon} aria-hidden="true">+</span>
          <strong>Esta casa ainda não tem perfis.</strong>
          <p>Crie o primeiro perfil para separar histórico e recomendações.</p>
          <button className={styles.stateAction} type="button" onClick={openCreateDialog}>
            Criar primeiro perfil
          </button>
        </div>
      ) : (
        <>
          <div
            className={styles.profileGrid}
            ref={gridRef}
            onKeyDown={handleGridNavigation}
            aria-label="Perfis disponíveis. Use as setas ou Tab para navegar."
          >
            {profiles.map((profile, index) => {
              const tone = tones[index % tones.length];
              const toneClass = toneClassMap[tone] ?? styles.toneBlue;
              const isActivating = activatingId === profile.id;
              const isOtherActivating = activatingId !== null && !isActivating;

              return (
                <button
                  className={`${styles.profileCard} ${isActivating ? styles.profileCardActivating : ""} ${isOtherActivating ? styles.profileCardDimmed : ""}`}
                  data-profile-card
                  type="button"
                  key={profile.id}
                  onClick={() => handleProfileClick(profile)}
                  aria-label={
                    isManaging
                      ? `Editar perfil ${profile.name}`
                      : `${profile.name}${profile.hasPin ? ", protegido por PIN" : ""}`
                  }
                  disabled={activatingId !== null}
                >
                  <ProfileAvatar
                    name={profile.name}
                    avatarUrl={profile.avatarUrl}
                    toneClass={toneClass}
                  />

                  {profile.hasPin && !isManaging && (
                    <span className={styles.pinBadge} title="Protegido por PIN">
                      <LockIcon />
                    </span>
                  )}

                  {isManaging && (
                    <span className={styles.editBadge} aria-hidden="true">
                      <span className={styles.editPencilCircle}>
                        <PencilIcon size={20} />
                      </span>
                    </span>
                  )}

                  <span className={styles.profileName}>{profile.name}</span>
                </button>
              );
            })}

            {profiles.length < 8 && (
              <button
                className={`${styles.profileCard} ${styles.addCard} ${activatingId !== null ? styles.profileCardDimmed : ""}`}
                data-profile-card
                type="button"
                aria-label={`Adicionar perfil (${profiles.length} de 8 utilizados)`}
                disabled={activatingId !== null}
                onClick={openCreateDialog}
              >
                <span className={styles.addAvatar} aria-hidden="true">
                  <PlusIcon />
                </span>
                <span className={styles.profileName}>Adicionar perfil</span>
              </button>
            )}
          </div>

          <div className={styles.footerActions} style={{ marginTop: "2.8rem" }}>
            <button
              type="button"
              className={`${styles.manageButton} ${isManaging ? styles.manageButtonActive : ""}`}
              onClick={() => setIsManaging((prev) => !prev)}
              disabled={activatingId !== null}
            >
              {isManaging ? (
                "Concluir"
              ) : (
                <>
                  <PencilIcon size={16} />
                  <span>Gerenciar perfis</span>
                </>
              )}
            </button>
          </div>
        </>
      )}

      {/* PIN Enter Dialog */}
      {selectedProfile && (
        <div className={styles.dialogBackdrop} role="presentation">
          <section
            className={styles.pinDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pin-title"
            aria-describedby="pin-description"
            onKeyDown={(event) => handleModalKeyDown(event, closePinDialog)}
          >
            <button
              className={styles.dialogClose}
              type="button"
              onClick={closePinDialog}
              aria-label="Fechar"
              disabled={activatingId !== null}
            >
              ×
            </button>

            <div className={styles.dialogHero}>
              <div className={styles.dialogHeroAvatarWrapper}>
                <ProfileAvatar
                  name={selectedProfile.name}
                  avatarUrl={selectedProfile.avatarUrl}
                  className={styles.dialogHeroAvatar}
                />
              </div>
              <p className={styles.dialogEyebrow}>Perfil protegido</p>
              <h2 id="pin-title" className={styles.dialogTitle}>PIN de {selectedProfile.name}</h2>
              <p id="pin-description" className={styles.dialogDescription}>Digite o PIN para continuar.</p>
            </div>

            <form onSubmit={handlePinSubmit} aria-busy={activatingId !== null}>
              <div style={{ margin: "1rem 0" }}>
                <input
                  id="profile-pin"
                  name="pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  pattern="[0-9]{4}"
                  minLength={4}
                  maxLength={4}
                  placeholder="••••"
                  className={styles.pinBox}
                  required
                  autoFocus
                  disabled={activatingId !== null}
                />
              </div>
              <p className={styles.pinMessage} role="status" aria-live="polite">{pinMessage}</p>
              <button className={styles.pinSubmit} type="submit" disabled={activatingId !== null}>
                Entrar
              </button>
            </form>
          </section>
        </div>
      )}

      {/* Edit Profile Dialog */}
      {editingProfile && (
        <div className={styles.dialogBackdrop} role="presentation">
          <section
            className={styles.editDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-profile-title"
            onKeyDown={(event) => handleModalKeyDown(event, closeEditDialog)}
          >
            <button
              className={styles.dialogClose}
              type="button"
              onClick={closeEditDialog}
              aria-label="Fechar"
              disabled={isSaving}
            >
              ×
            </button>

            <div className={styles.dialogHero}>
              <div className={styles.dialogHeroAvatarWrapper}>
                <ProfileAvatar
                  name={editName || editingProfile.name}
                  avatarUrl={editAvatar}
                  className={styles.dialogHeroAvatar}
                />
              </div>
              <p className={styles.dialogEyebrow}>Editar perfil</p>
              <h2 id="edit-profile-title" className={styles.dialogTitle}>{editName || editingProfile.name}</h2>
              <p className={styles.dialogDescription}>Personalize o nome, ícone e segurança do perfil.</p>
            </div>

            <form onSubmit={handleEditSubmit} aria-busy={isSaving}>
              <div className={styles.formSection}>
                <label htmlFor="edit-name" className={styles.sectionLabel}>Nome do perfil</label>
                <input
                  id="edit-name"
                  className={styles.nameInput}
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={80}
                  required
                  placeholder="Nome do perfil"
                  disabled={isSaving}
                />
              </div>

              <div className={styles.formSection}>
                <span className={styles.sectionLabel}>Ícone</span>
                <div className={styles.avatarPickerStrip}>
                  <button
                    type="button"
                    className={`${styles.avatarPickerItem} ${!editAvatar ? styles.avatarPickerItemActive : ""}`}
                    onClick={() => setEditAvatar(null)}
                    title="Inicial do nome"
                  >
                    <strong style={{ fontSize: "1.1rem" }}>
                      {(editName || editingProfile.name).trim().charAt(0).toLocaleUpperCase("pt-BR") || "?"}
                    </strong>
                  </button>

                  {AVATAR_PRESETS.map((preset) => {
                    const presetKey = formatPresetKey(preset.id);
                    const isSelected = editAvatar === presetKey || editAvatar === preset.id;
                    return (
                      <button
                        type="button"
                        key={preset.id}
                        className={`${styles.avatarPickerItem} ${isSelected ? styles.avatarPickerItemActive : ""}`}
                        onClick={() => setEditAvatar(presetKey)}
                        title={preset.label}
                      >
                        {preset.renderIcon({ size: 20 })}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Compact PIN Section */}
              <div className={styles.formSection}>
                <span className={styles.sectionLabel}>Segurança</span>
                <div className={`${styles.compactPinContainer} ${editPinOpen ? styles.compactPinContainerOpen : ""}`}>
                  <button
                    type="button"
                    className={styles.compactPinToggle}
                    onClick={() => setEditPinOpen(!editPinOpen)}
                  >
                    <span className={styles.compactPinToggleLabel}>
                      <LockIcon />
                      <span>PIN</span>
                    </span>
                    <span className={`${styles.compactPinToggleStatus} ${editingProfile.hasPin && editPinAction !== "remove" ? styles.statusActive : ""}`}>
                      {editingProfile.hasPin
                        ? editPinAction === "remove"
                          ? "Será removido"
                          : editPinAction === "change"
                          ? "Alterando"
                          : "Ativo"
                        : editPinAction === "change"
                        ? "Configurando"
                        : "Desativado"}
                    </span>
                  </button>

                  {editPinOpen && (
                    <div className={styles.compactPinDrawer}>
                      {editingProfile.hasPin ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                          {editPinAction === "keep" ? (
                            <div style={{ display: "flex", gap: "0.5rem" }}>
                              <button
                                type="button"
                                className={styles.pinActionBtn}
                                onClick={() => setEditPinAction("change")}
                              >
                                Alterar PIN
                              </button>
                              <button
                                type="button"
                                className={styles.pinActionBtn}
                                onClick={() => setEditPinAction("remove")}
                              >
                                Remover PIN
                              </button>
                            </div>
                          ) : editPinAction === "change" ? (
                            <>
                              <input
                                id="edit-new-pin"
                                className={styles.pinBox}
                                type="password"
                                inputMode="numeric"
                                pattern="[0-9]{4}"
                                minLength={4}
                                maxLength={4}
                                value={editPin}
                                onChange={(e) => setEditPin(e.target.value)}
                                placeholder="••••"
                                required
                                autoFocus
                              />
                              <button
                                type="button"
                                className={styles.pinActionBtn}
                                style={{ alignSelf: "flex-start" }}
                                onClick={() => {
                                  setEditPinAction("keep");
                                  setEditPin("");
                                }}
                              >
                                Cancelar alteração
                              </button>
                            </>
                          ) : (
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                              <span style={{ color: "#fca5a5", fontSize: "0.82rem" }}>O PIN será removido ao salvar</span>
                              <button
                                type="button"
                                className={styles.pinActionBtn}
                                onClick={() => setEditPinAction("keep")}
                              >
                                Desfazer
                              </button>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                          <input
                            id="edit-add-pin"
                            className={styles.pinBox}
                            type="password"
                            inputMode="numeric"
                            pattern="[0-9]{4}"
                            minLength={4}
                            maxLength={4}
                            value={editPin}
                            onChange={(e) => {
                              setEditPin(e.target.value);
                              setEditPinAction(e.target.value ? "change" : "keep");
                            }}
                            placeholder="••••"
                            autoFocus
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <p className={styles.pinMessage} role="status" aria-live="polite">{editMessage}</p>

              <div className={styles.dialogButtonGroup}>
                <button className={styles.pinSubmit} type="submit" disabled={isSaving}>
                  {isSaving ? "Salvando…" : "Salvar alterações"}
                </button>

                <div className={styles.dialogButtonRow}>
                  <button
                    type="button"
                    className={styles.deleteBtn}
                    onClick={() => openDeleteConfirm(editingProfile)}
                    disabled={isSaving}
                  >
                    <TrashIcon />
                    <span>Excluir</span>
                  </button>

                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={closeEditDialog}
                    disabled={isSaving}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </form>
          </section>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      {deleteConfirmProfile && (
        <div className={styles.dialogBackdrop} role="presentation" style={{ zIndex: 110 }}>
          <section
            className={styles.pinDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
            onKeyDown={(event) => handleModalKeyDown(event, closeDeleteConfirm)}
          >
            <div className={styles.dialogHero} style={{ marginBottom: "0.5rem" }}>
              <div className={styles.dialogHeroAvatarWrapper}>
                <span className={`${styles.dialogHeroAvatar} ${styles.toneCoral}`} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }} aria-hidden="true">
                  <TrashIcon size={36} />
                </span>
              </div>
              <p className={styles.dialogEyebrow}>Confirmar exclusão</p>
              <h2 id="delete-confirm-title" className={styles.dialogTitle}>
                Excluir {deleteConfirmProfile.name}?
              </h2>
              <p className={styles.dialogDescription} style={{ maxWidth: "18rem", margin: "0.5rem auto 0" }}>
                O histórico, lista e preferências deste perfil serão apagados permanentemente.
              </p>
            </div>

            <p className={styles.pinMessage} role="status" aria-live="polite">{deleteMessage}</p>

            <div className={styles.dialogButtonGroup} style={{ marginTop: "1.2rem" }}>
              <button
                type="button"
                className={styles.dangerSubmit}
                onClick={() => handleDeleteProfile(deleteConfirmProfile.id)}
                disabled={isDeleting}
              >
                {isDeleting ? "Excluindo…" : "Sim, excluir perfil"}
              </button>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={closeDeleteConfirm}
                disabled={isDeleting}
              >
                Cancelar
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Create Profile Dialog */}
      {isCreateOpen && (
        <div className={styles.dialogBackdrop} role="presentation">
          <section
            className={styles.editDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-profile-title"
            onKeyDown={(event) => handleModalKeyDown(event, closeCreateDialog)}
          >
            <button
              className={styles.dialogClose}
              type="button"
              onClick={closeCreateDialog}
              aria-label="Fechar"
              disabled={isCreating}
            >
              ×
            </button>

            <div className={styles.dialogHero}>
              <div className={styles.dialogHeroAvatarWrapper}>
                <ProfileAvatar
                  name={createName || "Novo"}
                  avatarUrl={createAvatar}
                  className={styles.dialogHeroAvatar}
                />
              </div>
              <p className={styles.dialogEyebrow}>Novo perfil</p>
              <h2 id="create-profile-title" className={styles.dialogTitle}>Criar perfil</h2>
              <p className={styles.dialogDescription}>Histórico, lista e recomendações exclusivas.</p>
            </div>

            <form onSubmit={handleCreateSubmit} aria-busy={isCreating}>
              <div className={styles.formSection}>
                <label htmlFor="new-profile-name" className={styles.sectionLabel}>Nome do perfil</label>
                <input
                  id="new-profile-name"
                  className={styles.nameInput}
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  minLength={1}
                  maxLength={80}
                  placeholder="Ex.: Lucas, Filmes da Família..."
                  required
                  autoFocus
                  disabled={isCreating}
                />
              </div>

              <div className={styles.formSection}>
                <span className={styles.sectionLabel}>Ícone</span>
                <div className={styles.avatarPickerStrip}>
                  <button
                    type="button"
                    className={`${styles.avatarPickerItem} ${!createAvatar ? styles.avatarPickerItemActive : ""}`}
                    onClick={() => setCreateAvatar(null)}
                    title="Inicial do nome"
                  >
                    <strong style={{ fontSize: "1.1rem" }}>
                      {createName.trim().charAt(0).toLocaleUpperCase("pt-BR") || "?"}
                    </strong>
                  </button>

                  {AVATAR_PRESETS.map((preset) => {
                    const presetKey = formatPresetKey(preset.id);
                    const isSelected = createAvatar === presetKey;
                    return (
                      <button
                        type="button"
                        key={preset.id}
                        className={`${styles.avatarPickerItem} ${isSelected ? styles.avatarPickerItemActive : ""}`}
                        onClick={() => setCreateAvatar(presetKey)}
                        title={preset.label}
                      >
                        {preset.renderIcon({ size: 20 })}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Compact PIN Section */}
              <div className={styles.formSection}>
                <span className={styles.sectionLabel}>Segurança</span>
                <div className={`${styles.compactPinContainer} ${createWithPin ? styles.compactPinContainerOpen : ""}`}>
                  <button
                    type="button"
                    className={styles.compactPinToggle}
                    onClick={() => setCreateWithPin(!createWithPin)}
                  >
                    <span className={styles.compactPinToggleLabel}>
                      <LockIcon />
                      <span>PIN</span>
                    </span>
                    <span className={`${styles.compactPinToggleStatus} ${createWithPin ? styles.statusActive : ""}`}>
                      {createWithPin ? "Ativado" : "Desativado"}
                    </span>
                  </button>

                  {createWithPin && (
                    <div className={styles.compactPinDrawer}>
                      <input
                        id="new-profile-pin"
                        className={styles.pinBox}
                        type="password"
                        inputMode="numeric"
                        pattern="[0-9]{4}"
                        minLength={4}
                        maxLength={4}
                        value={createPin}
                        onChange={(e) => setCreatePin(e.target.value)}
                        placeholder="••••"
                        required
                        autoFocus
                        disabled={isCreating}
                      />
                    </div>
                  )}
                </div>
              </div>

              <p className={styles.pinMessage} role="status" aria-live="polite">{createMessage}</p>

              <div className={styles.dialogButtonGroup}>
                <button className={styles.pinSubmit} type="submit" disabled={isCreating}>
                  {isCreating ? "Criando…" : "Salvar perfil"}
                </button>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={closeCreateDialog}
                  disabled={isCreating}
                >
                  Cancelar
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}

package br.cebola.app;

/** Guarda a orientação do aplicativo por toda a sessão, inclusive ao trocar de mídia. */
final class PlayerOrientationSession {
    private Integer original;

    void captureIfNeeded(int requested, int unspecified, boolean currentlyPortrait, int portrait) {
        if (original != null) return;
        original = requested == unspecified && currentlyPortrait ? portrait : requested;
    }

    Integer finish() {
        Integer result = original;
        original = null;
        return result;
    }
}

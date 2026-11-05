package br.cebola.app;

/** Mesmos limites de início do motor Linux; tempo decorrido deve ser monotônico. */
public final class StreamingReadiness {
    private StreamingReadiness() {}

    public enum Decision { WAIT, READY, TOO_SLOW }

    public static Decision evaluate(long fileSize, long downloadedBytes, long bytesPerSecond, long elapsedMs) {
        if (fileSize > 0 && downloadedBytes >= Math.min(8L * 1024 * 1024, fileSize)) {
            return Decision.READY;
        }
        if (elapsedMs < 20_000) return Decision.WAIT;
        return bytesPerSecond >= 512L * 1024 ? Decision.READY : Decision.TOO_SLOW;
    }
}
